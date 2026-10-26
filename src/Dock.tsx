import { useState, useEffect, useLayoutEffect, useMemo, useRef, memo } from "react";
import { motion, AnimatePresence, Reorder, useMotionValue, useTransform, useSpring, type MotionValue } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./Dock.css";
import { EdgeSurface } from "./components/EdgeSurface";
import { initTheme } from "./theme";
import { useSettingsSync } from "./hooks/useSettingsSync";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";

import {
	mergeTrayApps,
	selectDockTrayApps,
	isBrowserHost,
	appIdentity,
	itemKey,
	fileOf,
	isIdentifier,
	isVeloraSettingsApp,
	isSameApp,
	type AppInfo,
	type TrayApp
} from "./dockApps";
import { driveLetter, hideDrive, removeCustomFolder, type DockExtra, type FolderFileEntry } from "./dockExtras";
import { createRegionSender, measureElements, padRect, type RegionRect } from "./windowRegion";

export { isBrowserHost, appIdentity, isVeloraSettingsApp, isSameApp };

// WinEvent notifications can arrive for windows that do not change the dock.
// Keep the existing array when its visible content is identical so Framer
// Motion does not restart dock layout work on every notification.
function sameRunningApps(left: AppInfo[], right: AppInfo[]): boolean {
	return (
		left.length === right.length &&
		left.every((app, index) => {
			const next = right[index];
			return (
				app.name === next.name &&
				app.path === next.path &&
				app.icon === next.icon &&
				app.is_running === next.is_running &&
				app.is_background === next.is_background &&
				app.hwnd === next.hwnd &&
				app.executable === next.executable &&
				(app.tray_ids?.join("\0") ?? "") === (next.tray_ids?.join("\0") ?? "") &&
				JSON.stringify(app.all_hwnds ?? []) === JSON.stringify(next.all_hwnds ?? [])
			);
		})
	);
}

// Resolve the configured start-button icon to a public asset, or to the data
// URI of a user-uploaded icon (stored with a "custom:" prefix).
// Task View's glyph: a window in front of another, as on the taskbar.
function TaskViewIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round">
			<rect x="3.5" y="7.5" width="13" height="13" rx="3" />
			<path d="M8 3.5h9.5a3 3 0 0 1 3 3V16" />
		</svg>
	);
}

function resolveStartIcon(startIcon: string): string {
	if (startIcon === "velora-colorful") return "/velora-colorful.png";
	if (startIcon === "velora-golden") return "/velora-golden.png";
	if (startIcon === "velora-biscuit") return "/velora-biscuit.png";
	if (startIcon === "windows") return "/windows-11.png";
	if (startIcon.startsWith("custom:")) return startIcon.slice("custom:".length);
	return "/velora.png";
}

// Stable module-level constants so object references never change between renders,
// preventing Framer Motion from re-triggering animations on every re-render.
const ITEM_ENTRY_TRANSITION = {
	opacity: { duration: 0.15, delay: 0.15 },
	scale: { type: "spring" as const, stiffness: 400, damping: 25, delay: 0.15 }
};
const ITEM_INITIAL = { opacity: 0, scale: 0 };
const ITEM_ANIMATE = { opacity: 1, scale: 1 };
const ITEM_EXIT = { opacity: 0, scale: 0 };

// One dot per open window, capped at three.
function WindowDots({ count, background }: { count: number; background?: boolean }) {
	return (
		<div
			className="window-dots"
			role="img"
			aria-label={background ? "Running in background" : `${count} open windows`}
		>
			{Array.from({ length: background ? 1 : Math.min(Math.max(count, 1), 3) }, (_, i) => (
				<div key={i} className={`active-indicator${background ? " background-indicator" : ""}`} />
			))}
		</div>
	);
}

export function getBadgeCount(app: AppInfo): number {
	let maxCount = 0;
	const countRegex = /(?:\((\d+)\+?\)|\[(\d+)\+?\])/;
	const textRegex = /(?:^|\s)(\d+)\s+(?:new|unread|messages?|notifications?)/i;

	const testTitle = (title?: string) => {
		if (!title) return;
		const countMatch = countRegex.exec(title);
		if (countMatch) {
			const n = parseInt(countMatch[1] || countMatch[2], 10);
			if (!isNaN(n) && n > 0) maxCount = Math.max(maxCount, n);
			return;
		}
		const textMatch = textRegex.exec(title);
		if (textMatch) {
			const n = parseInt(textMatch[1], 10);
			if (!isNaN(n) && n > 0) maxCount = Math.max(maxCount, n);
		}
	};

	if (app.all_hwnds) {
		for (const [, title] of app.all_hwnds) {
			testTitle(title);
		}
	}
	if (app.name) {
		testTitle(app.name);
	}
	return maxCount;
}

function formatFileSize(bytes: number): string {
	if (bytes === 0) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface DockItemIconProps {
	mouseX: MotionValue<number>;
	magnificationEnabled: boolean;
	pressed: boolean;
	hovered: boolean;
	isDragging?: boolean;
	variants: any;
	whileDrag?: string;
	children: React.ReactNode;
	className?: string;
	style?: React.CSSProperties;
	onPointerDown?: (e: React.PointerEvent) => void;
	onPointerUp?: (e: React.PointerEvent) => void;
	onPointerCancel?: (e: React.PointerEvent) => void;
	onClick?: (e: React.MouseEvent) => void;
}

const DockItemIcon = memo(function DockItemIcon({
	mouseX,
	magnificationEnabled,
	pressed,
	hovered,
	isDragging = false,
	variants,
	whileDrag,
	children,
	className = "",
	style = {},
	...rest
}: DockItemIconProps) {
	const ref = useRef<HTMLDivElement>(null);
	const distance = useTransform(mouseX, (val) => {
		if (!magnificationEnabled || val === Infinity || !ref.current) return 0;
		const rect = ref.current.getBoundingClientRect();
		return val - (rect.left + rect.width / 2);
	});

	const targetScale = useTransform(distance, (d) => {
		if (!magnificationEnabled || d === 0) return 1;
		const R = 115;
		const absD = Math.abs(d);
		if (absD >= R) return 1;
		return 1 + 0.44 * Math.pow(Math.cos((absD / R) * (Math.PI / 2)), 2);
	});

	const springScale = useSpring(targetScale, { stiffness: 450, damping: 28, mass: 0.1 });
	const springY = useTransform(springScale, (s) => (s - 1) * -14);

	return (
		<motion.div
			ref={ref}
			className={`dock-icon ${className}`}
			variants={variants}
			animate={
				pressed
					? "tap"
					: isDragging
						? "idle"
						: hovered && !magnificationEnabled
							? "hover"
							: "idle"
			}
			whileDrag={whileDrag}
			style={{
				...style,
				scale: magnificationEnabled ? springScale : undefined,
				y: magnificationEnabled ? springY : undefined,
				transformOrigin: "bottom center"
			}}
			{...rest}
		>
			{children}
		</motion.div>
	);
});

const FolderStackPopover = memo(function FolderStackPopover({
	stack,
	scale,
	onClose,
	onOpenFile,
	onOpenFolder,
	onToggleViewMode
}: {
	stack: {
		extra: DockExtra;
		files: FolderFileEntry[];
		anchorX: number;
		viewMode: "fan" | "grid";
	};
	scale: number;
	onClose: () => void;
	onOpenFile: (file: FolderFileEntry) => void;
	onOpenFolder: () => void;
	onToggleViewMode: () => void;
}) {
	const estimatedWidth = stack.viewMode === "grid" ? 420 : 280;
	const margin = 16;
	const left = Math.max(
		margin + estimatedWidth / 2,
		Math.min(window.innerWidth - margin - estimatedWidth / 2, stack.anchorX)
	);

	return (
		<motion.div
			className="folder-stack-popover"
			initial={{ opacity: 0, y: 15, scale: 0.95 }}
			animate={{ opacity: 1, y: 0, scale: 1 }}
			exit={{ opacity: 0, y: 10, scale: 0.95 }}
			transition={{ duration: 0.18, ease: "easeOut" }}
			style={{
				left: left / scale,
				zoom: scale
			}}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="folder-stack-header">
				<div className="folder-stack-title-group">
					{stack.extra.icon && (
						<img src={stack.extra.icon} alt="" className="folder-stack-icon" draggable={false} />
					)}
					<div>
						<div className="folder-stack-title">{stack.extra.name}</div>
						<div className="folder-stack-count">
							{stack.files.length} {stack.files.length === 1 ? "item" : "items"}
						</div>
					</div>
				</div>
				<div className="folder-stack-actions">
					<button
						type="button"
						className={`folder-stack-mode-btn ${stack.viewMode === "grid" ? "active" : ""}`}
						title={stack.viewMode === "grid" ? "Switch to Fan View" : "Switch to Grid View"}
						onClick={onToggleViewMode}
					>
						{stack.viewMode === "grid" ? "Fan" : "Grid"}
					</button>
					<button type="button" className="folder-stack-mode-btn" title="Close" onClick={onClose}>
						✕
					</button>
				</div>
			</div>

			{stack.files.length === 0 ? (
				<div
					style={{
						padding: "24px 16px",
						textAlign: "center",
						color: "rgba(255,255,255,0.4)",
						fontSize: "12px"
					}}
				>
					Folder is empty
				</div>
			) : stack.viewMode === "grid" ? (
				<div className="folder-stack-grid">
					{stack.files.map((file) => (
						<div
							key={file.path}
							className="folder-stack-item"
							title={file.name}
							onClick={() => onOpenFile(file)}
						>
							{file.icon ? (
								<img src={file.icon} alt={file.name} draggable={false} />
							) : (
								<div
									className="fallback-icon"
									style={{ width: 44, height: 44, borderRadius: 8, fontSize: 18 }}
								>
									{file.is_dir ? "📁" : "📄"}
								</div>
							)}
							<div className="folder-stack-item-name">{file.name}</div>
							<div className="folder-stack-item-size">
								{file.is_dir ? "Folder" : formatFileSize(file.size_bytes)}
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="folder-stack-fan">
					{stack.files.map((file) => (
						<div
							key={file.path}
							className="folder-stack-fan-item"
							title={file.name}
							onClick={() => onOpenFile(file)}
						>
							{file.icon ? (
								<img src={file.icon} alt={file.name} draggable={false} />
							) : (
								<div
									className="fallback-icon"
									style={{ width: 32, height: 32, borderRadius: 6, fontSize: 14 }}
								>
									{file.is_dir ? "📁" : "📄"}
								</div>
							)}
							<div className="folder-stack-fan-item-info">
								<div className="folder-stack-fan-item-name">{file.name}</div>
								<div className="folder-stack-fan-item-size">
									{file.is_dir ? "Folder" : formatFileSize(file.size_bytes)}
								</div>
							</div>
						</div>
					))}
				</div>
			)}

			<div className="folder-stack-footer">
				<button type="button" className="folder-stack-open-btn" onClick={onOpenFolder}>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
					</svg>
					Open in File Explorer
				</button>
			</div>
		</motion.div>
	);
});

const Dock = memo(function Dock() {
	useEffect(() => {
		return initTheme();
	}, []);

	const [pinnedApps, setPinnedApps] = useState<AppInfo[]>([]);
	const [activeApps, setActiveApps] = useState<AppInfo[]>([]);
	const iconsRef = useRef<Record<string, string>>({});
	const [, setIconsTick] = useState(0);
	const [dockMode, setDockMode] = useState(() => {
		const raw = localStorage.getItem("velora-dock-mode") || "smart";
		if (raw === "auto-hide") return "smart";
		return raw;
	});
	const [dockPreviewEnabled, setDockPreviewEnabled] = useState(
		() => localStorage.getItem("velora-dock-preview-enabled") !== "false"
	);
	const [dockIconOnly, setDockIconOnly] = useState(
		() => localStorage.getItem("velora-dock-icon-only") === "true"
	);
	const [dockSeparatorEnabled, setDockSeparatorEnabled] = useState(
		() => localStorage.getItem("velora-dock-separator-enabled") !== "false"
	);
	const [dockAdaptive, setDockAdaptive] = useState(
		() => localStorage.getItem("velora-dock-adaptive") === "true"
	);
	const [dockTaskView, setDockTaskView] = useState(
		() => localStorage.getItem("velora-dock-task-view") === "true"
	);
	const [startIcon, setStartIcon] = useState(
		() => localStorage.getItem("velora-start-icon") || "default"
	);
	const [dockExtrasPosition, setDockExtrasPosition] = useState(
		() => localStorage.getItem("velora-dock-extras-position") || "off"
	);
	const [dockMagnificationEnabled, setDockMagnificationEnabled] = useState(
		() => localStorage.getItem("velora-dock-magnification") !== "false"
	);
	const [dockFolderStacksEnabled, setDockFolderStacksEnabled] = useState(
		() => localStorage.getItem("velora-dock-folder-stacks") !== "false"
	);
	const [dockBadgesEnabled, setDockBadgesEnabled] = useState(
		() => localStorage.getItem("velora-dock-badges") !== "false"
	);
	const [dockShowRecentsEnabled, setDockShowRecentsEnabled] = useState(
		() => localStorage.getItem("velora-dock-show-recents") !== "false"
	);
	const mouseX = useMotionValue(Infinity);
	const [activeStack, setActiveStack] = useState<{
		extra: DockExtra;
		files: FolderFileEntry[];
		anchorX: number;
		viewMode: "fan" | "grid";
	} | null>(null);
	const [recentApps, setRecentApps] = useState<AppInfo[]>(() => {
		try {
			const raw = localStorage.getItem("velora-recent-apps");
			return raw
				? (JSON.parse(raw) as AppInfo[]).filter((item) => !isVeloraSettingsApp(item))
				: [];
		} catch {
			return [];
		}
	});
	const [dockExtras, setDockExtras] = useState<DockExtra[]>([]);
	const [dockExtrasRevision, setDockExtrasRevision] = useState(0);
	const [isMaximized, setIsMaximized] = useState(false);
	const [previewData, setPreviewData] = useState<{
		id: string;
		previews: { hwnd: number; title: string; image: string }[];
	} | null>(null);
	const [isDockHovered, setIsDockHovered] = useState(false);
	const [isEdgeHovered, setIsEdgeHovered] = useState(false);
	const [isOverlapped, setIsOverlapped] = useState(false);
	const [isVisible, setIsVisible] = useState(true);
	const [showAddPopup, setShowAddPopup] = useState(false);
	const [nativeMenuOpen, setNativeMenuOpen] = useState(false);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		app: AppInfo | null;
		extra?: DockExtra | null;
		taskView?: boolean;
	} | null>(null);
	const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
	const [activeOrder, setActiveOrder] = useState<string[]>([]);
	const observedTrayPathsRef = useRef(new Set<string>());
	const [isDragging, setIsDragging] = useState(false);
	const [hoveredApp, setHoveredApp] = useState<string | null>(null);
	const [pressedApp, setPressedApp] = useState<string | null>(null);
	const [isReady, setIsReady] = useState(false);
	const [isImpacted, setIsImpacted] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [startupAnimating, setStartupAnimating] = useState(false);
	const [customIcons, setCustomIcons] = useState<Record<string, string>>({});
	const [toast, setToast] = useState<string | null>(null);
	const iconPickerTargetRef = useRef<string | null>(null);
	const toastTimerRef = useRef<any>(null);
	const dockRef = useRef<HTMLDivElement>(null);
	const [popupBottom, setPopupBottom] = useState(56);
	const pinnedItemsRef = useRef<AppInfo[]>([]);
	const handleAppClickRef = useRef<(app: AppInfo) => void>(() => { });
	const [scale, setScale] = useState(() =>
		parseFloat(localStorage.getItem("velora-scale") || "1.0")
	);
	const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

	useEffect(() => {
		const onResize = () => setViewportWidth(window.innerWidth);
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	// Measure the dock pill when the popup opens; the card tucks ~14px
	// behind the pill (which paints above it), so the seam stays fused even
	// if the measurement is off by a few px at some scale.
	useEffect(() => {
		if (showAddPopup) {
			const h = dockRef.current?.getBoundingClientRect().height ?? 0;
			if (h > 0) setPopupBottom(h / (scale || 1) - 14);
		}
	}, [showAddPopup, scale]);

	const isCurrentlyHovered = isDockHovered || isEdgeHovered;
	const [interactionState, setInteractionState] = useState<"active" | "grace" | "none">("none");
	const isAnyInteraction = isCurrentlyHovered || !!contextMenu || showAddPopup || nativeMenuOpen;

	const previewTimerRef = useRef<any>(null);
	const isPreviewHoveredRef = useRef(false);
	const hoveredAppRef = useRef<string | null>(null);

	useEffect(() => {
		if (isAnyInteraction) {
			setInteractionState("active");
		} else if (interactionState !== "none") {
			setInteractionState("grace");
			const timer = setTimeout(() => setInteractionState("none"), 800);
			return () => clearTimeout(timer);
		}
	}, [isAnyInteraction]);

	const isHidden =
		!startupAnimating &&
		((dockMode === "smart" && isOverlapped && interactionState === "none") ||
			(dockMode === "peek" && interactionState === "none"));

	// Adaptive mode (fixed dock only): stretch into a full-width taskbar while a
	// standard maximized window is in the foreground, so the reserved strip no
	// longer looks like a cut-out around the centered pill.
	const isAdaptive =
		dockAdaptive && dockMode === "fixed" && isMaximized && isExpanded && !isHidden && isVisible;
	// Nearly full width — 24px margin per side at the visual (scaled) size.
	// Pre-transform: visual = width * scale, so width = (viewport - 48*scale) / scale.
	const adaptiveWidth = (viewportWidth - 48 * scale) / scale;

	useEffect(() => {
		let cleared = false;

		const checkVisibility = async (): Promise<boolean> => {
			try {
				const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
				const visible = await getCurrentWebviewWindow().isVisible();
				if (visible) {
					setStartupAnimating(true);
					setIsReady(true);
					setTimeout(() => setIsImpacted(true), 280);
					setTimeout(() => setIsExpanded(true), 350);
					setTimeout(() => setStartupAnimating(false), 1500);
					return true;
				}
			} catch (_) { }
			return false;
		};

		// Keep polling until visible — no time cap, since the dock can be
		// enabled at runtime from settings after any delay.
		const interval = setInterval(async () => {
			if (cleared) return;
			if (await checkVisibility()) {
				clearInterval(interval);
				cleared = true;
			}
		}, 200);

		// Also attempt immediately
		checkVisibility().then((ok) => {
			if (ok) {
				clearInterval(interval);
				cleared = true;
			}
		});

		return () => {
			clearInterval(interval);
			cleared = true;
		};
	}, []);

	useEffect(() => {
		const updateRect = () => {
			if (dockRef.current) {
				const rect = dockRef.current.getBoundingClientRect();
				const hasPreview = !!previewData;
				invoke("update_dock_rect", {
					rect: {
						x: Math.round(rect.x) - (hasPreview ? 500 : 0),
						y: Math.round(rect.y) - (hasPreview ? 320 : 0),
						width: Math.round(rect.width) + (hasPreview ? 1000 : 0),
						height: Math.round(rect.height) + (hasPreview ? 320 : 0)
					}
				}).catch(() => { });
			}
		};

		updateRect();
		window.addEventListener("resize", updateRect);
		const observer = new ResizeObserver(updateRect);
		if (dockRef.current) observer.observe(dockRef.current);

		return () => {
			window.removeEventListener("resize", updateRect);
			observer.disconnect();
		};
	}, [pinnedApps, activeApps, isHidden, previewData, scale]);

	useEffect(() => {
		const init = async () => {
			const settings: any = await invoke("load_settings").catch(() => ({}));
			if (await reloadIfMirrorWasStale(settings)) return;
			const getVal = (key: string, fallback: string | null = null) => {
				const val = settings[key];
				if (val !== undefined && val !== null) return String(val);
				const local = localStorage.getItem(key);
				if (local !== null) return local;
				return fallback;
			};

			const dMode = getVal("velora-dock-mode", "smart");
			if (dMode) {
				const mapped = dMode === "auto-hide" ? "smart" : dMode;
				setDockMode(mapped);
			}

			const preview = getVal("velora-dock-preview-enabled", "true");
			setDockPreviewEnabled(preview === "true");

			const iconOnly = getVal("velora-dock-icon-only", "false");
			setDockIconOnly(iconOnly === "true");

			const separator = getVal("velora-dock-separator-enabled", "true");
			setDockSeparatorEnabled(separator === "true");

			const adaptive = getVal("velora-dock-adaptive", "false");
			setDockAdaptive(adaptive === "true");
			setDockTaskView(getVal("velora-dock-task-view", "false") === "true");

			const startIconVal = getVal("velora-start-icon", "default") || "default";
			setStartIcon(startIconVal);

			const extrasPosition = getVal("velora-dock-extras-position", "off");
			if (extrasPosition) setDockExtrasPosition(extrasPosition);

			const magn = getVal("velora-dock-magnification", "true");
			setDockMagnificationEnabled(magn !== "false");

			const stacks = getVal("velora-dock-folder-stacks", "true");
			setDockFolderStacksEnabled(stacks !== "false");

			const badges = getVal("velora-dock-badges", "true");
			setDockBadgesEnabled(badges !== "false");

			const recents = getVal("velora-dock-show-recents", "true");
			setDockShowRecentsEnabled(recents !== "false");

			const scaleVal = getVal("velora-scale");
			if (scaleVal !== null) setScale(parseFloat(scaleVal));

			const pinned = await invoke<AppInfo[]>("load_pinned_apps");
			setPinnedApps(pinned.map((a) => ({ ...a, is_pinned: true })));
			pinned.forEach((app) => fetchIcon(app.path));

			// Warm the installed-apps cache in the background so the add-app
			// popup opens with data ready instead of waiting on the scan.
			invoke<AppInfo[]>("get_installed_apps").catch(() => { });

			// Load custom icons
			try {
				const icons = await invoke<Record<string, string>>("get_custom_icons");
				setCustomIcons(icons);
			} catch (_) { }
		};
		init();

		// The installed-apps scan finishes after the first load; pins saved under
		// their executable's name then get their Start menu name.
		const unlistenInstalledApps = listen("installed-apps-updated", async () => {
			try {
				const refreshed = await invoke<AppInfo[]>("load_pinned_apps");
				const names = new Map(refreshed.map((a) => [a.path, a.name]));
				setPinnedApps((prev) => {
					const next = prev.map((a) => ({ ...a, name: names.get(a.path) ?? a.name }));
					if (!next.some((a, i) => a.name !== prev[i].name)) return prev;
					// Pins are otherwise saved only when they change; keep the names.
					queueMicrotask(() => {
						invoke("save_pinned_apps", { apps: next }).catch(console.error);
					});
					return next;
				});
			} catch (_) { }
		});

		const unlistenOverlap = listen<boolean>("dock-overlap", (event) => {
			setIsOverlapped(event.payload);
		});

		const unlistenEdgeHover = listen<boolean>("dock-edge-hover", (event) => {
			setIsEdgeHovered(event.payload);
		});

		const unlistenVisibility = listen<boolean>("visibility-change", (event) => {
			setIsVisible(event.payload);
		});

		const unlistenMaximized = listen<boolean>("dock-maximized", (event) => {
			setIsMaximized(event.payload);
		});

		return () => {
			unlistenOverlap.then((f) => f());
			unlistenInstalledApps.then((f) => f());
			unlistenEdgeHover.then((f) => f());
			unlistenVisibility.then((f) => f());
			unlistenMaximized.then((f) => f());
		};
	}, []);

	useSettingsSync({
		"velora-dock-mode": setDockMode,
		"velora-dock-preview-enabled": setDockPreviewEnabled,
		"velora-dock-icon-only": setDockIconOnly,
		"velora-dock-separator-enabled": setDockSeparatorEnabled,
		"velora-dock-adaptive": setDockAdaptive,
		"velora-dock-task-view": setDockTaskView,
		"velora-start-icon": setStartIcon,
		"velora-scale": setScale,
		"velora-dock-extras-position": setDockExtrasPosition,
		"velora-dock-extras-drives": () => setDockExtrasRevision((r) => r + 1),
		"velora-dock-extras-recycle-bin": () => setDockExtrasRevision((r) => r + 1),
		"velora-dock-extras-hidden-drives": () => setDockExtrasRevision((r) => r + 1),
		"velora-dock-extras-folders": () => setDockExtrasRevision((r) => r + 1),
		"velora-dock-extras-custom-folders": () => setDockExtrasRevision((r) => r + 1),
		"velora-dock-magnification": setDockMagnificationEnabled,
		"velora-dock-folder-stacks": setDockFolderStacksEnabled,
		"velora-dock-badges": setDockBadgesEnabled,
		"velora-dock-show-recents": setDockShowRecentsEnabled
	});

	useEffect(() => {
		if (dockExtrasPosition === "off") {
			setDockExtras([]);
			return;
		}
		let stopped = false;
		let loadSeq = 0;
		const load = async () => {
			const seq = ++loadSeq;
			try {
				const extras = await invoke<DockExtra[]>("get_dock_extras");
				// A slow load must never overwrite a newer one that already landed.
				if (!stopped && seq === loadSeq) setDockExtras(extras);
			} catch (e) {
				console.error("Failed to load dock extras:", e);
			}
		};
		load();

		// Drives can be plugged in or removed at any time; converge like the
		// window list does instead of trusting a one-shot fetch.
		const interval = setInterval(load, 10000);
		return () => {
			stopped = true;
			clearInterval(interval);
		};
	}, [dockExtrasPosition, dockExtrasRevision]);

	useEffect(() => {
		let pollSeq = 0;
		let stopped = false;

		const poll = async () => {
			if (isDragging) return;
			const seq = ++pollSeq;
			let windows: AppInfo[];
			let tray: TrayApp[];
			try {
				[windows, tray] = await Promise.all([
					invoke<AppInfo[]>("get_active_windows"),
					invoke<TrayApp[]>("get_tray_apps").catch(() => [])
				]);
			} catch (error) {
				console.error("Failed to refresh dock apps:", error);
				return;
			}
			// Ignore responses that arrive out of order: an older poll must never
			// overwrite a newer state, which would resurrect closed apps.
			if (stopped || seq !== pollSeq) return;
			const selected = selectDockTrayApps(windows, tray, observedTrayPathsRef.current, (app) =>
				pinnedApps.some((pinned) =>
					isSameApp(pinned, {
						name: app.name,
						path: app.path,
						icon: null,
						is_running: true,
						executable: fileOf(app.path)
					})
				)
			);
			observedTrayPathsRef.current = selected.observed;
			const running = mergeTrayApps(windows, selected.visible);
			setActiveApps((prev) => (sameRunningApps(prev, running) ? prev : running));

			setActiveOrder((prev) => {
				const newPaths = running.map((r) => appIdentity(r.path, r.executable, r.name));
				const existingPaths = prev.filter((p) => newPaths.includes(p));
				const addedPaths = newPaths.filter((p) => !prev.includes(p));
				const next = [...existingPaths, ...addedPaths];
				return next.length === prev.length && next.every((path, i) => path === prev[i])
					? prev
					: next;
			});

			running.forEach((app) => fetchIcon(app.path, app.name, app.hwnd));

			if (dockShowRecentsEnabled) {
				const unpinnedRunning = running.filter(
					(r) =>
						r.path !== "start" &&
						!isVeloraSettingsApp(r) &&
						!pinnedApps.some((p) => isSameApp(p, r))
				);
				if (unpinnedRunning.length > 0) {
					setRecentApps((prev) => {
						let updated = [...prev];
						for (const app of unpinnedRunning) {
							const id = itemKey(app);
							updated = updated.filter((item) => itemKey(item) !== id);
							updated.unshift({
								name: app.name,
								path: app.path,
								icon: app.icon,
								is_running: false,
								executable: app.executable
							});
						}
						const filtered = updated
							.filter(
								(item) =>
									!isVeloraSettingsApp(item) &&
									!pinnedApps.some((p) => isSameApp(p, item))
							)
							.slice(0, 3);
						if (JSON.stringify(filtered.map(itemKey)) !== JSON.stringify(prev.map(itemKey))) {
							try {
								localStorage.setItem("velora-recent-apps", JSON.stringify(filtered));
							} catch {}
							return filtered;
						}
						return prev;
					});
				}
			}
		};

		poll();

		const unlistenWindowChange = listen("windows-changed", () => {
			poll();
		});

		// Safety net: even if a window event is missed, converge on the real state
		const interval = setInterval(poll, 10000);

		return () => {
			stopped = true;
			clearInterval(interval);
			unlistenWindowChange.then((f) => f());
		};
	}, [isDragging, pinnedApps]);

	const fetchIcon = async (path: string, name?: string, hwnd?: number, retryCount = 0) => {
		const isHost = isBrowserHost(path);
		const cacheKey =
			isHost && name ? `${path}:${name.toLowerCase()}` : hwnd ? `${path}-${hwnd}` : path;

		if (iconsRef.current[cacheKey]) return;
		try {
			const icon = await invoke<string | null>("get_app_icon", {
				path,
				name: name || null,
				hwnd: hwnd || null
			});
			if (icon) {
				iconsRef.current[cacheKey] = icon;
				if (!isHost) iconsRef.current[path] = icon;
				setIconsTick((t) => t + 1);
			} else if (retryCount < 3 && !hwnd) {
				setTimeout(() => fetchIcon(path, name, undefined, retryCount + 1), 3000 * (retryCount + 1));
			}
		} catch (e) {
			console.error(`Failed to fetch icon for ${path}:`, e);
			if (retryCount < 3 && !hwnd) {
				setTimeout(() => fetchIcon(path, name, undefined, retryCount + 1), 3000 * (retryCount + 1));
			}
		}
	};

	const handleClearIconCache = async () => {
		try {
			await invoke("clear_icon_cache");
			iconsRef.current = {};
			setIconsTick((t) => t + 1);
			pinnedApps.forEach((app) => fetchIcon(app.path));
		} catch (e) {
			console.error("Failed to clear icon cache:", e);
		}
	};

	const handleIconFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		const target = iconPickerTargetRef.current;
		if (!file || !target) return;

		const reader = new FileReader();
		reader.onload = async () => {
			const dataUri = reader.result as string;
			try {
				const newIcon = await invoke<string>("set_custom_icon", {
					cacheKey: target,
					iconData: dataUri
				});
				setCustomIcons((prev) => ({ ...prev, [target]: newIcon }));
			} catch (err) {
				const msg = typeof err === "string" ? err : "Failed to set icon";
				if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
				setToast(msg);
				toastTimerRef.current = setTimeout(() => setToast(null), 4000);
			}
		};
		reader.readAsDataURL(file);
		e.target.value = "";
	};

	const handleRemoveCustomIcon = async (app: AppInfo) => {
		try {
			await invoke("remove_custom_icon", { path: app.path, name: app.name || null });
			const isHost = isBrowserHost(app.path);
			const ck =
				isHost && app.name
					? `${app.path}:${app.name.toLowerCase()}`
					: app.hwnd
						? `${app.path}-${app.hwnd}`
						: app.path;
			setCustomIcons((prev) => {
				const next = { ...prev };
				delete next[ck];
				delete next[app.path];
				return next;
			});
			// Invalidate only this app's cached icon and re-fetch only this app
			delete iconsRef.current[ck];
			delete iconsRef.current[app.path];
			if (app.hwnd) delete iconsRef.current[`${app.path}-${app.hwnd}`];
			setIconsTick((t) => t + 1);
			fetchIcon(app.path, app.name, app.hwnd);
		} catch (err) {
			console.error("Failed to remove custom icon:", err);
		}
	};

	const handleClosePreview = async (e: React.MouseEvent, hwnd: number) => {
		e.stopPropagation();
		try {
			await invoke("close_window", { hwnd });
			setPreviewData((prev) => {
				if (!prev) return null;
				const remaining = prev.previews.filter((p) => p.hwnd !== hwnd);
				if (remaining.length === 0) {
					setHoveredApp(null);
					return null;
				}
				return { ...prev, previews: remaining };
			});
		} catch (err) {
			console.error("Failed to close window:", err);
		}
	};

	const handleAppClick = async (app: AppInfo) => {
		try {
			if (app.path === "start") {
				await invoke("open_app", { appName: "start" });
			} else if (app.is_background && app.tray_ids?.length === 1) {
				await invoke("activate_tray_icon", { trayId: app.tray_ids[0] });
			} else if (app.all_hwnds && app.all_hwnds.length > 1) {
				// Several windows: bring the most recent forward, then cycle.
				await invoke("focus_app_windows", { hwnds: app.all_hwnds.map(([hwnd]) => hwnd) });
			} else if (app.hwnd) {
				await invoke("focus_window", { hwnd: app.hwnd });
			} else {
				await invoke("open_app", { appName: app.path });
			}
		} catch (e) {
			console.error(`Failed to interact with ${app.name}:`, e);
			showActionError(e);
		}
	};

	const handleNewInstance = async (app: AppInfo) => {
		if (!app || app.path === "start") return;
		try {
			await invoke("launch_new_instance", { appPath: app.path, appName: app.name });
		} catch (e) {
			console.error(`Failed to launch a new instance of ${app.name}:`, e);
		}
	};

	// Middle-click opens a new instance, matching the native taskbar. The
	// mousedown preventDefault suppresses Chromium's autoscroll cursor.
	const handleMiddleClick = (e: React.MouseEvent, app: AppInfo) => {
		if (e.button !== 1) return;
		e.preventDefault();
		e.stopPropagation();
		handleNewInstance(app);
	};

	const togglePin = async (app: AppInfo) => {
		let newPinned;
		if (app.is_pinned) {
			newPinned = pinnedApps.filter((a) => itemKey(a) !== itemKey(app));
		} else {
			// Fuzzy guard: the same app pinned via another entry shape (running
			// window vs installed shortcut) must never create a duplicate.
			if (pinnedApps.some((a) => isSameApp(a, app))) return;
			newPinned = [...pinnedApps, { ...app, is_pinned: true, is_running: false, hwnd: undefined }];
			fetchIcon(app.path, app.name);
		}
		setPinnedApps(newPinned);
		await invoke("save_pinned_apps", { apps: newPinned });
		closeMenu();
	};

	const menuRef = useRef<HTMLDivElement>(null);
	const popupRef = useRef<HTMLDivElement>(null);

	const showActionError = (error: unknown) => {
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
		setToast(typeof error === "string" ? error : "Could not complete this action.");
		toastTimerRef.current = setTimeout(() => setToast(null), 5000);
	};

	const openTrayMenu = async (trayId: string) => {
		setNativeMenuOpen(true);
		closeMenu();
		setPreviewData(null);
		try {
			await invoke("show_tray_context_menu", { trayId });
		} catch (error) {
			showActionError(error);
		} finally {
			setNativeMenuOpen(false);
		}
	};

	const handleContextMenu = (e: React.MouseEvent, app: AppInfo | null) => {
		e.stopPropagation();
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, app });
	};

	const handleExtraClick = async (extra: DockExtra, e?: React.MouseEvent) => {
		if (
			dockFolderStacksEnabled &&
			(extra.kind === "folder" || extra.kind === "custom") &&
			extra.path &&
			!extra.path.startsWith("shell:")
		) {
			if (activeStack?.extra.id === extra.id) {
				setActiveStack(null);
				return;
			}
			try {
				const files = await invoke<FolderFileEntry[]>("get_folder_stack", {
					path: extra.path,
					maxItems: 12
				});
				const clickX = e ? e.clientX : window.innerWidth / 2;
				setActiveStack({
					extra,
					files,
					anchorX: clickX,
					viewMode: files.length <= 5 ? "fan" : "grid"
				});
				return;
			} catch (err) {
				console.error("Failed to load folder stack:", err);
			}
		}
		invoke("open_dock_extra", { kind: extra.kind, path: extra.path }).catch(showActionError);
	};

	const handleExtraContextMenu = (e: React.MouseEvent, extra: DockExtra) => {
		e.stopPropagation();
		e.preventDefault();
		setContextMenu({ x: e.clientX, y: e.clientY, app: null, extra });
	};

	const ejectExtra = (extra: DockExtra) => {
		closeMenu();
		invoke("eject_dock_extra", { path: extra.path }).catch(showActionError);
	};

	const removeExtraFromDock = (extra: DockExtra) => {
		const next = removeCustomFolder(
			localStorage.getItem("velora-dock-extras-custom-folders"),
			extra.path
		);
		localStorage.setItem("velora-dock-extras-custom-folders", next);
		invoke("save_setting", {
			key: "velora-dock-extras-custom-folders",
			value: next
		}).catch(console.error);
		closeMenu();
	};

	// Settings > Dock > Drives shows it again.
	const hideDriveFromDock = (extra: DockExtra) => {
		const letter = driveLetter(extra);
		if (!letter) return;
		const next = hideDrive(localStorage.getItem("velora-dock-extras-hidden-drives"), letter);
		localStorage.setItem("velora-dock-extras-hidden-drives", next);
		invoke("save_setting", { key: "velora-dock-extras-hidden-drives", value: next }).catch(
			showActionError
		);
		closeMenu();
	};

	const openTaskView = () => {
		invoke("open_system_action", { action: "task-view" }).catch(showActionError);
	};

	// Like the taskbar's "Hide Task View button"; Settings turns it back on.
	const hideTaskView = () => {
		setDockTaskView(false);
		localStorage.setItem("velora-dock-task-view", "false");
		invoke("save_setting", { key: "velora-dock-task-view", value: "false" }).catch(
			showActionError
		);
		closeMenu();
	};

	// Measured before paint: the menu's height depends on which items it shows,
	// so it opens just above the cursor and stays inside the dock window.
	// Positions are in visual pixels; the menu's CSS zoom scales left/top.
	const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (!contextMenu || !menuRef.current) {
			setMenuPos(null);
			return;
		}
		const margin = 8;
		const r = menuRef.current.getBoundingClientRect();
		setMenuPos({
			left: Math.max(margin, Math.min(contextMenu.x, window.innerWidth - r.width - margin)),
			top: Math.max(margin, contextMenu.y - r.height - margin)
		});
	}, [contextMenu, scale]);

	const closeMenu = () => {
		setContextMenu(null);
		setActiveSubmenu(null);
		setActiveStack(null);
		invoke("set_menu_open", { open: false, rect: null }).catch(() => { });
	};

	const closePopup = () => {
		setShowAddPopup(false);
		invoke("set_menu_open", { open: false, rect: null }).catch(() => { });
	};

	// A press outside the dock while a menu or the Add App popup is open. The
	// click itself goes to whatever is under it (the window region keeps the
	// dock out of the way), so the backend's mouse hook reports it instead.
	useEffect(() => {
		const unlisten = listen("dock-dismiss-menu", () => {
			setContextMenu(null);
			setActiveSubmenu(null);
			setShowAddPopup(false);
			setActiveStack(null);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	// The tallest the expanded bar has been, which sets the region's bottom band.
	const dockBandHeightRef = useRef(0);
	const sendDockRegion = useMemo(
		() =>
			createRegionSender((rects) => {
				invoke("set_window_region", { rects }).catch(() => { });
			}),
		[]
	);

	// Clip the dock window to what it draws (see window_region.rs). The bar
	// gets a full-width band along the bottom, as tall as the expanded bar plus
	// room for the icons' lift and tooltips above it, so its reveal and width
	// animations are never clipped; the click-through switching still keeps
	// the band clear unless the cursor is at the dock. The floating parts are
	// measured, padded for their shadows. While an icon is dragged the whole
	// window is included so the dragged icon isn't clipped.
	useEffect(() => {
		const bar = dockRef.current?.getBoundingClientRect();
		if (bar && isExpanded && !isHidden && isVisible) {
			dockBandHeightRef.current = Math.max(dockBandHeightRef.current, bar.height);
		}
		const band = (dockBandHeightRef.current || 72 * scale) + 64 * scale;
		const wanted: RegionRect[] = [
			{ x: 0, y: window.innerHeight - band, width: window.innerWidth, height: band }
		];
		if (isDragging) {
			wanted.push({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
		}
		wanted.push(
			...measureElements([
				[".preview-tooltip", 40],
				[".context-menu", 34],
				[".submenu", 34],
				[".dock-toast", 20],
				[".folder-stack-popover", 40]
			])
		);
		// The Add App popup grows from scaleY 0, and that animation doesn't
		// re-render the dock, so its own box would be measured collapsed. Its
		// anchor isn't transformed and is exactly as tall as the open popup, so
		// the height comes from there and the width from the popup itself.
		const popup = popupRef.current;
		const anchor = popup?.parentElement;
		if (popup && anchor) {
			const p = popup.getBoundingClientRect();
			const a = anchor.getBoundingClientRect();
			wanted.push(padRect({ x: p.left, y: a.top, width: p.width, height: a.height }, 40));
		}
		sendDockRegion(wanted);
	});

	useEffect(() => {
		let open = false;
		let rect = null;

		if (contextMenu && menuRef.current) {
			const r = menuRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width + (activeSubmenu ? 160 : 0)),
				height: Math.round(r.height)
			};
			open = true;
		} else if (showAddPopup && popupRef.current) {
			const r = popupRef.current.getBoundingClientRect();
			rect = {
				x: Math.round(r.x),
				y: Math.round(r.y),
				width: Math.round(r.width),
				height: Math.round(r.height)
			};
			open = true;
		} else if (activeStack) {
			const el = document.querySelector(".folder-stack-popover");
			if (el) {
				const r = el.getBoundingClientRect();
				rect = {
					x: Math.round(r.x),
					y: Math.round(r.y),
					width: Math.round(r.width),
					height: Math.round(r.height)
				};
				open = true;
			}
		}

		invoke("set_menu_open", { open, rect }).catch(() => { });
	}, [contextMenu, menuPos, showAddPopup, activeStack, pinnedApps, activeApps, activeSubmenu, scale]);

	const dockItems = useMemo(() => {
		const runningMap = new Map();
		activeApps.forEach((a) => {
			const id = appIdentity(a.path, a.executable, a.name);
			if (!runningMap.has(id)) runningMap.set(id, a);
		});

		const matchedRunningKeys = new Set<string>();

		const findRunningApp = (p: AppInfo) => {
			// 1. Try exact match by identity
			const id = appIdentity(p.path, p.executable, p.name);
			let running = runningMap.get(id);
			if (running) {
				matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
				return running;
			}

			// 2. Try match by path (without executable)
			const pathId = appIdentity(p.path);
			running = runningMap.get(pathId);
			if (running) {
				matchedRunningKeys.add(appIdentity(running.path, running.executable, running.name));
				return running;
			}

			// 3. Try fallback match by executable name if defined
			if (p.executable) {
				const targetExe = p.executable.toLowerCase();
				const found = activeApps.find(
					(a) => !isIdentifier(a.path) && a.executable?.toLowerCase() === targetExe
				);
				if (found) {
					matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
					return found;
				}
			}

			// 4. Try fallback match by path's file name (e.g., if path is "msedge" and running app's executable is "msedge.exe")
			const pinFilename = p.path.split("/").pop()?.split("\\").pop()?.toLowerCase() || "";
			if (pinFilename) {
				const found = activeApps.find((a) => {
					if (isIdentifier(a.path)) return false;
					const runExe =
						a.executable?.toLowerCase() ||
						a.path.split("/").pop()?.split("\\").pop()?.toLowerCase() ||
						"";
					return (
						runExe === pinFilename ||
						runExe === `${pinFilename}.exe` ||
						`${runExe}.exe` === pinFilename
					);
				});
				if (found) {
					matchedRunningKeys.add(appIdentity(found.path, found.executable, found.name));
					return found;
				}
			}

			// A pinned shell id and a visible window can have different paths
			// (for example com.sujan.velora and velora.exe). Match both visible
			// and background apps so the window cannot become a second dock item.
			const equivalent = activeApps.find(
				(app) => !matchedRunningKeys.has(itemKey(app)) && isSameApp(p, app)
			);
			if (equivalent) {
				matchedRunningKeys.add(itemKey(equivalent));
				return equivalent;
			}
			return undefined;
		};

		const pinned: AppInfo[] = [
			{
				name: "Start",
				path: "start",
				icon: null,
				is_running: false,
				is_pinned: true,
				hwnd: undefined,
				all_hwnds: undefined,
				executable: undefined
			},
			...pinnedApps.map((p) => {
				const running = findRunningApp(p);
				return {
					...p,
					is_running: !!running,
					hwnd: running?.hwnd,
					all_hwnds: running?.all_hwnds,
					tray_ids: running?.tray_ids,
					is_background: running?.is_background
				};
			})
		];

		const unpinned = activeOrder
			.map((id) => activeApps.find((a) => appIdentity(a.path, a.executable, a.name) === id))
			.filter(
				(a): a is AppInfo =>
					!!a && !matchedRunningKeys.has(appIdentity(a.path, a.executable, a.name))
			);

		let finalUnpinned = unpinned;
		if (dockShowRecentsEnabled) {
			const activeKeys = new Set(unpinned.map(itemKey));
			const closedRecents = recentApps
				.filter(
					(r) =>
						!activeKeys.has(itemKey(r)) &&
						!isVeloraSettingsApp(r) &&
						!pinnedApps.some((p) => isSameApp(p, r))
				)
				.map((r) => ({
					...r,
					is_running: false,
					is_pinned: false
				}));
			finalUnpinned = [...unpinned, ...closedRecents];
		}

		return [...pinned, ...finalUnpinned];
	}, [pinnedApps, activeApps, activeOrder, dockShowRecentsEnabled, recentApps]);

	const startItem = useMemo(
		() => dockItems.find((i) => i.path === "start") as AppInfo,
		[dockItems]
	);
	const pinnedItems = useMemo(
		() => dockItems.filter((i) => i.path !== "start" && i.is_pinned),
		[dockItems]
	);
	const unpinnedItems = useMemo(() => dockItems.filter((i) => !i.is_pinned), [dockItems]);

	// Latest state for the Win+Number listener, which subscribes only once.
	useEffect(() => {
		pinnedItemsRef.current = pinnedItems;
		handleAppClickRef.current = handleAppClick;
	});

	useEffect(() => {
		// The backend claims Win+1-9 while the native taskbar is hidden and reports
		// which pinned slot was pressed; behaviour matches a click on that icon.
		const unlisten = listen<number>("dock-win-number", (event) => {
			const app = pinnedItemsRef.current[event.payload];
			if (app) handleAppClickRef.current(app);
		});
		return () => {
			unlisten.then((f) => f());
		};
	}, []);

	// Items are keyed by identity, not path: web apps running in the same
	// browser share one executable path.
	const handleReorder = (newKeys: string[]) => {
		const oldKeys = pinnedApps.map(itemKey);
		if (JSON.stringify(newKeys) !== JSON.stringify(oldKeys)) {
			const reordered = newKeys
				.map((key) => pinnedApps.find((p) => itemKey(p) === key))
				.filter((p): p is AppInfo => !!p);
			setPinnedApps(reordered);
		}
	};

	const handleDragEnd = () => {
		setIsDragging(false);
		setPressedApp(null);
		invoke("save_pinned_apps", { apps: pinnedApps }).catch(console.error);
	};

	useEffect(() => {
		// Only report true dock-window hover, not the edge-hover from Rust,
		// to avoid a feedback loop that keeps the dock open.
		invoke("set_dock_hovered", { hovered: isDockHovered }).catch(() => { });
	}, [isDockHovered]);

	useEffect(() => {
		const handleBlur = () => {
			closeMenu();
			closePopup();
			if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
			setPreviewData(null);
			setHoveredApp(null);
		};
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("blur", handleBlur);
			if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
		};
	}, []);

	const previewLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleAppMouseEnter = (appKey: string) => {
		if (previewLeaveTimerRef.current) {
			clearTimeout(previewLeaveTimerRef.current);
			previewLeaveTimerRef.current = null;
		}
		isPreviewHoveredRef.current = false;
		if (hoveredApp !== appKey) {
			setPreviewData(null);
		}
		setHoveredApp(appKey);
	};

	const handleAppMouseLeave = () => {
		if (previewLeaveTimerRef.current) {
			clearTimeout(previewLeaveTimerRef.current);
		}
		previewLeaveTimerRef.current = setTimeout(() => {
			if (!isPreviewHoveredRef.current) {
				setHoveredApp(null);
				setPressedApp(null);
				setPreviewData(null);
			}
		}, 200);
	};

	const handlePreviewMouseEnter = () => {
		if (previewLeaveTimerRef.current) {
			clearTimeout(previewLeaveTimerRef.current);
			previewLeaveTimerRef.current = null;
		}
		isPreviewHoveredRef.current = true;
	};

	const handlePreviewMouseLeave = () => {
		isPreviewHoveredRef.current = false;
		if (previewLeaveTimerRef.current) {
			clearTimeout(previewLeaveTimerRef.current);
		}
		previewLeaveTimerRef.current = setTimeout(() => {
			setHoveredApp(null);
			setPressedApp(null);
			setPreviewData(null);
		}, 200);
	};

	useEffect(() => {
		if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		hoveredAppRef.current = hoveredApp;

		if (!hoveredApp) {
			const timer = setTimeout(() => setPreviewData(null), 250);
			return () => clearTimeout(timer);
		}

		setPreviewData((prev) => (prev && prev.id !== hoveredApp ? null : prev));

		if (hoveredApp && !isDragging) {
			const app = dockItems.find((a) => itemKey(a) === hoveredApp);
			if (app && app.is_running && !app.is_background) {
				const rawHwnds = (app.all_hwnds && app.all_hwnds.length > 0)
					? app.all_hwnds
					: (app.hwnd ? [[app.hwnd, app.name]] : []);
				const hwndsToCapture = rawHwnds.filter(([h]) => typeof h === "number" && h > 0);

				if (hwndsToCapture.length === 0) {
					setPreviewData(null);
					return;
				}

				previewTimerRef.current = setTimeout(async () => {
					try {
						const results = await Promise.all(
							hwndsToCapture.map(async ([hwnd, title]) => {
								try {
									const res = await invoke<[string, number] | null>("capture_window_thumbnail", {
										hwnd,
										maxWidth: 320,
										maxHeight: 200
									});
									if (res && res[0]) {
										const [image, lastFocused] = res;
										return { hwnd, title: title || app.name, image, lastFocused };
									}
								} catch (err) {
									console.warn("Failed to capture thumbnail for hwnd:", hwnd, err);
								}
								// Return window item even if live pixel capture is unavailable
								return { hwnd, title: title || app.name, image: "", lastFocused: 0 };
							})
						);

						const captured = results
							.filter(
								(r): r is { hwnd: number; title: string; image: string; lastFocused: number } =>
									r !== null
							)
							.sort((a, b) => b.lastFocused - a.lastFocused)
							.map(({ hwnd, title, image }) => ({ hwnd, title, image }));

						const currentHovered = hoveredAppRef.current;
						if (captured.length > 0 && currentHovered === itemKey(app)) {
							setPreviewData({ id: itemKey(app), previews: captured });
						} else if (currentHovered === itemKey(app)) {
							setPreviewData(null);
						}
					} catch (e) {
						console.error("Failed to capture thumbnails:", e);
						setPreviewData(null);
					}
				}, 250);
			} else {
				setPreviewData(null);
			}
		}

		return () => {
			if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
		};
	}, [hoveredApp, isDragging, dockItems]);

	const iconVariants = {
		idle: { y: 0, scale: 1 },
		hover: { y: -5, scale: 1.1 },
		drag: { y: -10, scale: 1.1, opacity: 0.8 },
		tap: { scale: 0.95 }
	};

	const renderExtra = (extra: DockExtra) => (
		<motion.div
			key={extra.id}
			layout
			initial={{ opacity: 0, scale: 0 }}
			animate={{ opacity: 1, scale: 1 }}
			exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
			className="dock-icon-wrapper"
			onContextMenu={(e) => handleExtraContextMenu(e, extra)}
			onMouseEnter={() => handleAppMouseEnter(extra.id)}
			onMouseLeave={handleAppMouseLeave}
			onMouseDown={(e) => {
				if (e.button === 1) e.preventDefault();
			}}
			onClick={(e) => {
				e.stopPropagation();
				handleExtraClick(extra, e);
			}}
		>
			{hoveredApp === extra.id && <div className="tooltip">{extra.name}</div>}
			<DockItemIcon
				mouseX={mouseX}
				magnificationEnabled={dockMagnificationEnabled}
				pressed={pressedApp === extra.id}
				hovered={hoveredApp === extra.id}
				variants={iconVariants}
				onPointerDown={() => setPressedApp(extra.id)}
				onPointerUp={() => setPressedApp(null)}
				onPointerCancel={() => setPressedApp(null)}
			>
				{extra.icon ? (
					<img src={extra.icon} alt={extra.name} draggable={false} />
				) : (
					<div className="fallback-icon">{extra.name[0]}</div>
				)}
			</DockItemIcon>
		</motion.div>
	);

	return (
		<div className={`dock-container ${isDragging ? "dragging" : ""}`} onClick={closeMenu}>
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					justifyContent: "center",
					alignItems: "flex-end"
				}}
			>
				<motion.div
					ref={dockRef}
					layout
					className={`dock ${isExpanded && !isHidden ? "dock-expanded" : ""} ${isImpacted && !isExpanded && !isHidden ? "dock-impacted" : ""} ${dockIconOnly ? "dock-icon-only" : ""} ${isAdaptive ? "dock-adaptive" : ""}`}
					onMouseMove={(e) => mouseX.set(e.clientX)}
					onMouseEnter={() => setIsDockHovered(true)}
					onMouseLeave={() => {
						mouseX.set(Infinity);
						setIsDockHovered(false);
						handleAppMouseLeave();
					}}
					initial={{
						y: -800,
						opacity: 1,
						width: 34,
						height: 34,
						borderTopLeftRadius: 17,
						borderTopRightRadius: 17,
						borderBottomLeftRadius: 17,
						borderBottomRightRadius: 17
					}}
					animate={{
						y: !isReady ? -800 : isVisible ? (isHidden ? 100 : 0) : 150,
						width:
							isExpanded && !isHidden && isVisible ? (isAdaptive ? adaptiveWidth : "auto") : 34,
						height: isExpanded && !isHidden && isVisible ? "auto" : 34,
						borderTopLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 18 : 17,
						borderTopRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 18 : 17,
						borderBottomLeftRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						borderBottomRightRadius: (isImpacted || isExpanded) && !isHidden && isVisible ? 0 : 17,
						opacity: isVisible ? 1 : 0,
						scale: scale
					}}
					transition={{
						y: { type: "spring", stiffness: 400, damping: 35, mass: 0.8 },
						width: { type: "spring", stiffness: 250, damping: 22, mass: 0.8 },
						height: { type: "spring", stiffness: 250, damping: 22, mass: 0.8 },
						layout: isDragging ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 25 },
						borderTopLeftRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderTopRightRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderBottomLeftRadius: { type: "spring", stiffness: 500, damping: 30 },
						borderBottomRightRadius: { type: "spring", stiffness: 500, damping: 30 },
						opacity: { type: "tween", duration: 0.2 },
						scale: { duration: 0 }
					}}
					style={{ originX: 0.5, originY: 1, minWidth: 34 }}
					onContextMenu={(e) => handleContextMenu(e, null)}
				>
					<EdgeSurface edge="bottom" flares={isExpanded && !isHidden} />
					<AnimatePresence>
						{activeStack && (
							<FolderStackPopover
								stack={activeStack}
								scale={scale}
								onClose={() => setActiveStack(null)}
								onOpenFile={(file) => {
									setActiveStack(null);
									invoke("open_dock_extra", {
										kind: file.is_dir ? "folder" : "file",
										path: file.path
									}).catch(showActionError);
								}}
								onOpenFolder={() => {
									const extra = activeStack.extra;
									setActiveStack(null);
									invoke("open_dock_extra", {
										kind: extra.kind,
										path: extra.path
									}).catch(showActionError);
								}}
								onToggleViewMode={() => {
									setActiveStack((prev) =>
										prev ? { ...prev, viewMode: prev.viewMode === "grid" ? "fan" : "grid" } : null
									);
								}}
							/>
						)}
					</AnimatePresence>
					<AnimatePresence>
						{isExpanded && (
							<motion.div
								key="dock-content"
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								exit={{ opacity: 0 }}
								transition={{ duration: 0.15 }}
								className="dock-reorder-container"
							>
								{startItem && (
									<motion.div
										initial={{ opacity: 0, scale: 0 }}
										animate={{ opacity: 1, scale: 1 }}
										transition={{
											opacity: { duration: 0.15, delay: 0.15 },
											scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.15 }
										}}
										className="dock-icon-wrapper"
										onContextMenu={(e) => handleContextMenu(e, startItem)}
										onMouseEnter={() => handleAppMouseEnter(itemKey(startItem))}
										onMouseLeave={handleAppMouseLeave}
									>
										{(!dockPreviewEnabled ||
											(dockPreviewEnabled && hoveredApp === itemKey(startItem))) && (
												<div className="tooltip">{startItem.name}</div>
											)}
										<DockItemIcon
											mouseX={mouseX}
											magnificationEnabled={dockMagnificationEnabled}
											pressed={pressedApp === itemKey(startItem)}
											hovered={hoveredApp === itemKey(startItem)}
											variants={iconVariants}
											onPointerDown={() => setPressedApp(itemKey(startItem))}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
											onClick={(e: React.MouseEvent) => {
												e.stopPropagation();
												handleAppClick(startItem);
											}}
										>
											<img
												src={resolveStartIcon(startIcon)}
												alt="Start"
												className="velora-icon-img"
												style={
													startIcon.startsWith("custom:") ? { borderRadius: "8px" } : undefined
												}
												draggable={false}
											/>
										</DockItemIcon>
									</motion.div>
								)}

								{dockTaskView && (
									<motion.div
										key="task-view"
										initial={{ opacity: 0, scale: 0 }}
										animate={{ opacity: 1, scale: 1 }}
										exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
										className="dock-icon-wrapper"
										onContextMenu={(e) => {
											e.stopPropagation();
											e.preventDefault();
											setContextMenu({ x: e.clientX, y: e.clientY, app: null, taskView: true });
										}}
										onMouseEnter={() => handleAppMouseEnter("task-view")}
										onMouseLeave={handleAppMouseLeave}
									>
										{(!dockPreviewEnabled || hoveredApp === "task-view") && (
											<div className="tooltip">Task View</div>
										)}
										<DockItemIcon
											mouseX={mouseX}
											magnificationEnabled={dockMagnificationEnabled}
											pressed={pressedApp === "task-view"}
											hovered={hoveredApp === "task-view"}
											variants={iconVariants}
											onPointerDown={() => setPressedApp("task-view")}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
											onClick={(e: React.MouseEvent) => {
												e.stopPropagation();
												openTaskView();
											}}
										>
											<TaskViewIcon />
										</DockItemIcon>
									</motion.div>
								)}

								{dockExtrasPosition === "left" && dockExtras.length > 0 && (
									<>
										{dockExtras.map((extra) => renderExtra(extra))}
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
									</>
								)}

								<Reorder.Group
									as="div"
									axis="x"
									values={pinnedItems.map(itemKey)}
									onReorder={handleReorder}
									className="dock-reorder-group"
								>
									{pinnedItems.map((app) => (
										<Reorder.Item
											as="div"
											key={itemKey(app)}
											value={itemKey(app)}
											style={{ position: "relative" }}
											onDragStart={() => {
												setIsDragging(true);
												if (previewLeaveTimerRef.current) clearTimeout(previewLeaveTimerRef.current);
												setHoveredApp(null);
												setPressedApp(null);
												setPreviewData(null);
											}}
											onDragEnd={handleDragEnd}
											onContextMenu={(e) => handleContextMenu(e, app)}
											onMouseDown={(e) => {
												if (e.button === 1) e.preventDefault();
											}}
											onAuxClick={(e) => handleMiddleClick(e, app)}
											onClick={(e) => {
												e.stopPropagation();
												if (!isDragging) handleAppClick(app);
											}}
										>
											<motion.div
												className="dock-icon-wrapper"
												initial={ITEM_INITIAL}
												animate={ITEM_ANIMATE}
												exit={ITEM_EXIT}
												transition={ITEM_ENTRY_TRANSITION}
												onMouseEnter={() => handleAppMouseEnter(itemKey(app))}
												onMouseLeave={handleAppMouseLeave}
											>
												<AnimatePresence>
													{dockPreviewEnabled &&
														previewData &&
														previewData.id === itemKey(app) &&
														hoveredApp === itemKey(app) && (
															<motion.div
																className={`preview-tooltip ${previewData.previews.length > 1 ? "multi" : ""}`}
																initial={{ opacity: 0, y: 10, scale: 0.95 }}
																animate={{ opacity: 1, y: 0, scale: 1 }}
																exit={{ opacity: 0, scale: 0.95 }}
																transition={{ duration: 0.15 }}
																onMouseEnter={handlePreviewMouseEnter}
																onMouseLeave={handlePreviewMouseLeave}
															>
																<div className="preview-items">
																	{previewData.previews.map((prev, idx) => (
																		<div
																			key={prev.hwnd}
																			className="preview-item"
																			onClick={() => {
																				invoke("focus_window", { hwnd: prev.hwnd });
																				setPreviewData(null);
																				setHoveredApp(null);
																			}}
																		>
																			{prev.image ? (
																				<img src={prev.image} alt={`Preview ${idx}`} />
																			) : (
																				<div className="preview-fallback-card">
																					{app.icon ? (
																						<img src={app.icon} className="preview-fallback-icon" alt="" />
																					) : (
																						<div className="preview-fallback-ph">🪟</div>
																					)}
																					<span className="preview-fallback-badge">Live Window</span>
																				</div>
																			)}
																			<div className="preview-label">{prev.title || app.name}</div>
																			<button
																				className="preview-close-btn"
																				onClick={(e) => handleClosePreview(e, prev.hwnd)}
																				title="Close Window"
																			>
																				<svg
																					width="10"
																					height="10"
																					viewBox="0 0 24 24"
																					fill="none"
																					stroke="currentColor"
																					strokeWidth="3"
																					strokeLinecap="round"
																				>
																					<line x1="18" y1="6" x2="6" y2="18"></line>
																					<line x1="6" y1="6" x2="18" y2="18"></line>
																				</svg>
																			</button>
																		</div>
																	))}
																</div>
															</motion.div>
														)}
												</AnimatePresence>

												{/* Fallback to text tooltip if previews are disabled, app isn't running, or preview failed to load */}
												{(!dockPreviewEnabled ||
													(dockPreviewEnabled && hoveredApp === itemKey(app) && !previewData)) && (
														<div className="tooltip">{app.name}</div>
													)}
												<DockItemIcon
													mouseX={mouseX}
													magnificationEnabled={dockMagnificationEnabled}
													pressed={pressedApp === itemKey(app)}
													hovered={hoveredApp === itemKey(app)}
													isDragging={isDragging}
													variants={iconVariants}
													whileDrag="drag"
													onPointerDown={() => setPressedApp(itemKey(app))}
													onPointerUp={() => setPressedApp(null)}
													onPointerCancel={() => setPressedApp(null)}
												>
													{(() => {
														const isHost = isBrowserHost(app.path);
														const cacheKey = isHost
															? `${app.path}:${app.name.toLowerCase()}`
															: app.hwnd
																? `${app.path}-${app.hwnd}`
																: app.path;
														// Running host items must not use the shared path fallback: the
														// browser and its PWAs share one path, so it would leak one item's
														// icon onto the others.
														const allowPathFallback = !isHost || !app.is_running;
														const icon =
															customIcons[cacheKey] ||
															(allowPathFallback && customIcons[app.path]) ||
															iconsRef.current[cacheKey] ||
															(allowPathFallback && iconsRef.current[app.path]) ||
															app.icon;

														const isVeloraOrSettings = isVeloraSettingsApp(app);

														const finalIcon = isVeloraOrSettings ? "/velora.png" : icon;

														return finalIcon ? (
															<img
																src={finalIcon}
																alt={app.name}
																className={isVeloraOrSettings ? "velora-icon-img" : ""}
																draggable={false}
															/>
														) : (
															<div className="fallback-icon">{app.name[0]}</div>
														);
													})()}
												</DockItemIcon>
												{dockBadgesEnabled && (() => {
													const count = getBadgeCount(app);
													if (count <= 0) return null;
													return (
														<div className="dock-badge">
															{count > 99 ? "99+" : count}
														</div>
													);
												})()}
												{app.is_running && (
													<WindowDots
														count={app.all_hwnds?.length ?? 1}
														background={app.is_background}
													/>
												)}
											</motion.div>
										</Reorder.Item>
									))}
								</Reorder.Group>

								{dockSeparatorEnabled &&
									unpinnedItems.length > 0 &&
									(pinnedItems.length > 0 || startItem) && (
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
									)}

								{unpinnedItems.map((app) => (
									<motion.div
										key={itemKey(app)}
										layout
										initial={{ opacity: 0, scale: 0 }}
										animate={{
											opacity: 1,
											scale: 1,
											transition: {
												opacity: { duration: 0.15, delay: 0.15 },
												scale: { type: "spring", stiffness: 400, damping: 25, delay: 0.15 }
											}
										}}
										exit={{ opacity: 0, scale: 0, transition: { duration: 0.12 } }}
										className="dock-icon-wrapper"
										onContextMenu={(e) => handleContextMenu(e, app)}
										onMouseEnter={() => handleAppMouseEnter(itemKey(app))}
										onMouseLeave={handleAppMouseLeave}
										onMouseDown={(e) => {
											if (e.button === 1) e.preventDefault();
										}}
										onAuxClick={(e) => handleMiddleClick(e, app)}
										onClick={(e) => {
											e.stopPropagation();
											handleAppClick(app);
										}}
									>
										<AnimatePresence>
											{dockPreviewEnabled &&
												previewData &&
												previewData.id === itemKey(app) &&
												hoveredApp === itemKey(app) && (
													<motion.div
														className={`preview-tooltip ${previewData.previews.length > 1 ? "multi" : ""}`}
														initial={{ opacity: 0, y: 10, scale: 0.95 }}
														animate={{ opacity: 1, y: 0, scale: 1 }}
														exit={{ opacity: 0, scale: 0.95 }}
														transition={{ duration: 0.15 }}
														onMouseEnter={handlePreviewMouseEnter}
														onMouseLeave={handlePreviewMouseLeave}
													>
														<div className="preview-items">
															{previewData.previews.map((prev, idx) => (
																<div
																	key={prev.hwnd}
																	className="preview-item"
																	onClick={() => {
																		invoke("focus_window", { hwnd: prev.hwnd });
																		setPreviewData(null);
																		setHoveredApp(null);
																	}}
																>
																	{prev.image ? (
																		<img src={prev.image} alt={`Preview ${idx}`} />
																	) : (
																		<div className="preview-fallback-card">
																			{app.icon ? (
																				<img src={app.icon} className="preview-fallback-icon" alt="" />
																			) : (
																				<div className="preview-fallback-ph">🪟</div>
																			)}
																			<span className="preview-fallback-badge">Live Window</span>
																		</div>
																	)}
																	<div className="preview-label">{prev.title || app.name}</div>
																	<button
																		className="preview-close-btn"
																		onClick={(e) => handleClosePreview(e, prev.hwnd)}
																		title="Close Window"
																	>
																		<svg
																			width="10"
																			height="10"
																			viewBox="0 0 24 24"
																			fill="none"
																			stroke="currentColor"
																			strokeWidth="3"
																			strokeLinecap="round"
																		>
																			<line x1="18" y1="6" x2="6" y2="18"></line>
																			<line x1="6" y1="6" x2="18" y2="18"></line>
																		</svg>
																	</button>
																</div>
															))}
														</div>
													</motion.div>
												)}
										</AnimatePresence>
										{(!dockPreviewEnabled ||
											(dockPreviewEnabled && hoveredApp === itemKey(app) && !previewData)) && (
												<div className="tooltip">{app.name}</div>
											)}
										<DockItemIcon
											mouseX={mouseX}
											magnificationEnabled={dockMagnificationEnabled}
											pressed={pressedApp === itemKey(app)}
											hovered={hoveredApp === itemKey(app)}
											variants={iconVariants}
											onPointerDown={() => setPressedApp(itemKey(app))}
											onPointerUp={() => setPressedApp(null)}
											onPointerCancel={() => setPressedApp(null)}
										>
											{(() => {
												const isHost = isBrowserHost(app.path);
												const cacheKey = isHost
													? `${app.path}:${app.name.toLowerCase()}`
													: app.hwnd
														? `${app.path}-${app.hwnd}`
														: app.path;
												// Running host items must not use the shared path fallback: the
												// browser and its PWAs share one path, so it would leak one item's
												// icon onto the others.
												const allowPathFallback = !isHost || !app.is_running;
												const icon =
													customIcons[cacheKey] ||
													(allowPathFallback && customIcons[app.path]) ||
													iconsRef.current[cacheKey] ||
													(allowPathFallback && iconsRef.current[app.path]) ||
													app.icon;
												const isVeloraOrSettings = isVeloraSettingsApp(app);

												const finalIcon = isVeloraOrSettings ? "/velora.png" : icon;

												return finalIcon ? (
													<img
														src={finalIcon}
														alt={app.name}
														className={isVeloraOrSettings ? "velora-icon-img" : ""}
														draggable={false}
													/>
												) : (
													<div className="fallback-icon">{app.name[0]}</div>
												);
											})()}
										</DockItemIcon>
										{dockBadgesEnabled && (() => {
											const count = getBadgeCount(app);
											if (count <= 0) return null;
											return (
												<div className="dock-badge">
													{count > 99 ? "99+" : count}
												</div>
											);
										})()}
										{app.is_running && (
											<WindowDots
												count={app.all_hwnds?.length ?? 1}
												background={app.is_background}
											/>
										)}
									</motion.div>
								))}

								{dockExtrasPosition === "right" && dockExtras.length > 0 && (
									<>
										<div
											className="dock-app-divider"
											role="separator"
											aria-orientation="vertical"
										/>
										{dockExtras.map((extra) => renderExtra(extra))}
									</>
								)}
							</motion.div>
						)}
					</AnimatePresence>
				</motion.div>
			</div>

			{contextMenu && (
				<div
					ref={menuRef}
					className="context-menu"
					style={{
						left: (menuPos?.left ?? contextMenu.x) / scale,
						top: (menuPos?.top ?? contextMenu.y) / scale,
						visibility: menuPos ? "visible" : "hidden",
						zoom: scale
					}}
					onClick={(e) => e.stopPropagation()}
				>
					{!contextMenu.extra &&
						!contextMenu.taskView &&
						(!contextMenu.app || contextMenu.app.path === "start") && (
							<div
								style={{
									maxHeight: Math.max(64, window.innerHeight / scale - 200),
									overflowY: "auto"
								}}
							>
								{(contextMenu.app
									? [
										["installed-apps", "Installed Apps"],
										["power-options", "Power Options"],
										["device-manager", "Device Manager"],
										["network-connections", "Network Connections"],
										["disk-management", "Disk Management"],
										["computer-management", "Computer Management"],
										["task-manager", "Task Manager"],
										["settings", "Settings"]
									]
									: [
										["task-manager", "Task Manager"],
										["taskbar-settings", "Taskbar Settings"]
									]
								).map(([action, label]) => (
									<div
										key={action}
										className="menu-item"
										onClick={() => {
											closeMenu();
											invoke("open_system_action", { action }).catch(showActionError);
										}}
									>
										{label}
									</div>
								))}
								<div className="menu-divider" />
							</div>
						)}
					{contextMenu.extra ? (
						<>
							<div
								className="menu-item"
								onClick={() => {
									const extra = contextMenu.extra!;
									closeMenu();
									handleExtraClick(extra);
								}}
							>
								Open
							</div>
							{contextMenu.extra.kind === "drive" && contextMenu.extra.removable && (
								<div className="menu-item" onClick={() => ejectExtra(contextMenu.extra!)}>
									Eject
								</div>
							)}
							{contextMenu.extra.kind === "drive" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item quit"
										onClick={() => hideDriveFromDock(contextMenu.extra!)}
									>
										Remove from Dock
									</div>
								</>
							)}
							{contextMenu.extra.kind === "custom" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item quit"
										onClick={() => removeExtraFromDock(contextMenu.extra!)}
									>
										Remove from Dock
									</div>
								</>
							)}
						</>
					) : contextMenu.taskView ? (
						<>
							<div
								className="menu-item"
								onClick={() => {
									closeMenu();
									openTaskView();
								}}
							>
								Open Task View
							</div>
							<div className="menu-divider" />
							<div className="menu-item" onClick={hideTaskView}>
								Hide Task View
							</div>
						</>
					) : contextMenu.app ? (
						<>
							{!contextMenu.app.is_running && contextMenu.app.path !== "start" && (
								<div
									className="menu-item"
									onClick={() => {
										const app = contextMenu.app!;
										closeMenu();
										handleAppClick(app);
									}}
								>
									Open
								</div>
							)}
							<div className="menu-item" onClick={() => togglePin(contextMenu.app!)}>
								{contextMenu.app.is_pinned ? "Unpin from Dock" : "Pin to Dock"}
							</div>
							{!contextMenu.app.is_pinned && recentApps.some((r) => isSameApp(r, contextMenu.app!)) && (
								<div
									className="menu-item"
									onClick={() => {
										const app = contextMenu.app!;
										closeMenu();
										setRecentApps((prev) => {
											const next = prev.filter((r) => !isSameApp(r, app));
											try {
												localStorage.setItem("velora-recent-apps", JSON.stringify(next));
											} catch {}
											return next;
										});
									}}
								>
									Remove from Recents
								</div>
							)}
							{contextMenu.app.is_pinned && contextMenu.app.path !== "start" && (
								<>
									<div className="menu-divider" />
									<div
										className="menu-item"
										onClick={() => {
											const isHost = isBrowserHost(contextMenu.app!.path);
											const ck = isHost
												? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
												: contextMenu.app!.path;
											iconPickerTargetRef.current = ck;
											closeMenu();
											setTimeout(() => {
												document.getElementById("icon-file-input")?.click();
											}, 50);
										}}
									>
										Change Icon...
									</div>
									{(() => {
										const isHost = isBrowserHost(contextMenu.app!.path);
										const ck = isHost
											? `${contextMenu.app!.path}:${contextMenu.app!.name.toLowerCase()}`
											: contextMenu.app!.path;
										return customIcons[ck] ? (
											<div
												className="menu-item"
												onClick={() => {
													handleRemoveCustomIcon(contextMenu.app!);
													closeMenu();
												}}
											>
												Reset Icon
											</div>
										) : null;
									})()}
								</>
							)}
							<div className="menu-divider" />
							<div
								className="menu-item"
								onClick={() => {
									setShowAddPopup(true);
									closeMenu();
								}}
							>
								Add App to Dock...
							</div>
							<div
								className="menu-item has-submenu"
								onMouseEnter={() => setActiveSubmenu("velora")}
								onMouseLeave={() => setActiveSubmenu(null)}
							>
								Velora Options
								<span className="submenu-arrow">▶</span>
								<div className="submenu">
									<div
										className="menu-item"
										onClick={() => {
											invoke("open_settings_window");
											closeMenu();
										}}
									>
										Open Settings
									</div>
									<div className="menu-item" onClick={() => invoke("restart_velora")}>
										Restart Velora
									</div>
									<div
										className="menu-item"
										onClick={() => {
											handleClearIconCache();
											closeMenu();
										}}
									>
										Clear Icon Cache
									</div>
									<div className="menu-divider" />
									<div className="menu-item quit" onClick={() => invoke("quit_velora")}>
										Quit Velora
									</div>
								</div>
							</div>
							{(() => {
								// App actions sit together just above Close, like the taskbar's
								// jump list: the app's tray menus, then a new instance.
								const app = contextMenu.app!;
								const canOpenNew = app.is_running && app.path !== "start";
								if (!app.tray_ids?.length && !canOpenNew) return null;
								return (
									<>
										<div className="menu-divider" />
										{app.tray_ids?.map((id, index, ids) => (
											<div key={id} className="menu-item" onClick={() => void openTrayMenu(id)}>
												{ids.length > 1 ? `Tray menu ${index + 1}` : "App tray menu"}
											</div>
										))}
										{canOpenNew && (
											<div
												className="menu-item"
												onClick={() => {
													handleNewInstance(app);
													closeMenu();
												}}
											>
												Open New Instance
											</div>
										)}
									</>
								);
							})()}
							{contextMenu.app.is_running && !contextMenu.app.is_background && (
								<>
									{contextMenu.app.path === "start" && !contextMenu.app.tray_ids?.length && (
										<div className="menu-divider" />
									)}
									<div
										className="menu-item quit"
										onClick={async () => {
											// Close every window of the item, like the taskbar's
											// "Close all windows", not just the first one.
											const app = contextMenu.app;
											const hwnds =
												app?.all_hwnds?.map(([hwnd]) => hwnd) ?? (app?.hwnd ? [app.hwnd] : []);
											await Promise.all(hwnds.map((hwnd) => invoke("close_window", { hwnd })));
											closeMenu();
										}}
									>
										Close{" "}
										{contextMenu.app.all_hwnds && contextMenu.app.all_hwnds.length > 1
											? "all windows"
											: "window"}
									</div>
								</>
							)}
						</>
					) : (
						<>
							<div
								className="menu-item"
								onClick={() => {
									setShowAddPopup(true);
									closeMenu();
								}}
							>
								Add App to Dock...
							</div>
							<div
								className="menu-item has-submenu"
								onMouseEnter={() => setActiveSubmenu("velora")}
								onMouseLeave={() => setActiveSubmenu(null)}
							>
								Velora Options
								<span className="submenu-arrow">▶</span>
								<div className="submenu">
									<div
										className="menu-item"
										onClick={() => {
											invoke("open_settings_window");
											closeMenu();
										}}
									>
										Open Settings
									</div>
									<div className="menu-item" onClick={() => invoke("restart_velora")}>
										Restart Velora
									</div>
									<div
										className="menu-item"
										onClick={() => {
											handleClearIconCache();
											closeMenu();
										}}
									>
										Clear Icon Cache
									</div>
									<div className="menu-divider" />
									<div className="menu-item quit" onClick={() => invoke("quit_velora")}>
										Quit Velora
									</div>
								</div>
							</div>
						</>
					)}
				</div>
			)}

			<input
				id="icon-file-input"
				type="file"
				accept=".png,.ico,.jpg,.jpeg,.svg,.bmp"
				style={{ display: "none" }}
				onChange={handleIconFileSelect}
			/>

			<AnimatePresence>
				{showAddPopup && (
					<AddAppPopup
						containerRef={popupRef}
						onClose={closePopup}
						onAdd={(app: AppInfo) => {
							togglePin(app);
							closePopup();
						}}
						scale={scale}
						runningApps={activeApps}
						pinned={pinnedApps}
						bottom={popupBottom}
					/>
				)}
			</AnimatePresence>

			<AnimatePresence>
				{toast && (
					<motion.div
						className="dock-toast"
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: 10 }}
						transition={{ duration: 0.2 }}
						style={{ zoom: scale }}
					>
						{toast}
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
});

function AddAppPopup({
	onClose,
	onAdd,
	containerRef,
	scale,
	runningApps,
	pinned,
	bottom
}: {
	onClose: () => void;
	onAdd: (app: AppInfo) => void;
	containerRef: React.RefObject<HTMLDivElement | null>;
	scale: number;
	runningApps: AppInfo[];
	pinned: AppInfo[];
	bottom: number;
}) {
	const [apps, setApps] = useState<AppInfo[]>([]);
	const [search, setSearch] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [listIcons, setListIcons] = useState<Record<string, string>>({});
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const mountedRef = useRef(false);

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search), 150);
		return () => clearTimeout(timer);
	}, [search]);

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	// Reset selection when search changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [debouncedSearch]);

	// Running, unpinned apps — already in memory, so the default view is
	// instant and relevant instead of the first 20 alphabetical installs.
	// Pinned matching is fuzzy: a pinned .lnk and its running .exe are the
	// same app and must not show up as pinnable again.
	const runningSuggestions = useMemo(
		() => runningApps.filter((a) => a.path !== "start" && !pinned.some((p) => isSameApp(p, a))),
		[runningApps, pinned]
	);

	const sections = useMemo(() => {
		const s = debouncedSearch.trim().toLowerCase();
		// No query: running apps first, then the full installed list.
		// Already-pinned entries are excluded; backend filters helper junk
		// (uninstallers, help/readme entries) out of the scan itself.
		if (!s) {
			const runningIds = new Set(runningSuggestions.map((a) => itemKey(a)));
			const rest = apps
				.filter(
					(a) =>
						a.path !== "start" &&
						!pinned.some((p) => isSameApp(p, a)) &&
						!runningIds.has(itemKey(a))
				)
				.slice(0, 60);
			const out: { title: string | null; items: AppInfo[] }[] = [];
			if (runningSuggestions.length > 0) out.push({ title: "Running", items: runningSuggestions });
			if (rest.length > 0) out.push({ title: "All apps", items: rest });
			return out;
		}
		const starts: AppInfo[] = [];
		const contains: AppInfo[] = [];
		for (const a of apps) {
			// Search covers everything, including pinned — unlike the browse
			// view, which skips what's already on the dock.
			if (a.path === "start") continue;
			const n = a.name.toLowerCase();
			if (n.startsWith(s)) starts.push(a);
			else if (n.includes(s)) contains.push(a);
		}
		const byName = (x: AppInfo, y: AppInfo) => x.name.localeCompare(y.name);
		starts.sort(byName);
		contains.sort(byName);
		return [{ title: null, items: [...starts, ...contains].slice(0, 50) }];
	}, [apps, debouncedSearch, pinned, runningSuggestions]);

	// Flat selectable list; section headers are not selectable.
	const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
	const flatIndex = useMemo(() => new Map(flat.map((a, i) => [a, i])), [flat]);

	// Keep selection in range as results narrow.
	useEffect(() => {
		setSelectedIndex((i) => Math.min(i, Math.max(0, flat.length - 1)));
	}, [flat.length]);

	// Scroll selected item into view on keyboard nav only — never on mount,
	// where it yanks the freshly-opened list and reads as jitter.
	useEffect(() => {
		if (!mountedRef.current) {
			mountedRef.current = true;
			return;
		}
		if (!listRef.current) return;
		const row = listRef.current.querySelector(
			`[data-idx="${selectedIndex}"]`
		) as HTMLElement | null;
		if (row) row.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	useEffect(() => {
		const load = async () => {
			try {
				const res = await invoke<AppInfo[]>("get_installed_apps");
				setApps(res.sort((a, b) => a.name.localeCompare(b.name)));
			} finally {
				setLoading(false);
			}
		};
		load();
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
			} else if (e.key === "Enter") {
				e.preventDefault();
				const target = flat[selectedIndex];
				if (!target) return;
				// Already on the dock: just dismiss, never pin twice.
				if (pinned.some((p) => isSameApp(p, target))) onClose();
				else onAdd(target);
			}
		};
		const handleMouseDown = (e: MouseEvent) => {
			const popup = containerRef.current;
			if (popup && !popup.contains(e.target as Node)) {
				onClose();
			}
		};
		const handleBlur = () => onClose();
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("blur", handleBlur);
		document.addEventListener("mousedown", handleMouseDown, true);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("blur", handleBlur);
			document.removeEventListener("mousedown", handleMouseDown, true);
		};
	}, [onClose, containerRef, flat, selectedIndex, onAdd, pinned]);

	// Fetch visible icons in parallel and commit as one batch. The old
	// sequential 20ms-per-icon loop popped icons in one by one, which read as
	// the list shifting after open. Row and icon boxes are fixed-size and
	// images fade in via onLoad, so late icons never move layout.
	useEffect(() => {
		let active = true;
		const targets = flat.slice(0, 25).filter((a) => !listIcons[a.path]);
		if (targets.length === 0) return;
		Promise.all(
			targets.map(async (app) => {
				try {
					const icon = await invoke<string | null>("get_app_icon", { path: app.path });
					return [app.path, icon] as const;
				} catch (err) {
					console.error(err);
					return [app.path, null] as const;
				}
			})
		).then((pairs) => {
			if (!active) return;
			const batch: Record<string, string> = {};
			for (const [path, icon] of pairs) if (icon) batch[path] = icon;
			if (Object.keys(batch).length > 0) setListIcons((prev) => ({ ...prev, ...batch }));
		});
		return () => {
			active = false;
		};
	}, [flat, listIcons]);

	return (
		<div className="add-popup-anchor" style={{ zoom: scale, bottom }}>
			<motion.div
				ref={containerRef}
				className="add-app-popup"
				style={{ transformOrigin: "bottom center" }}
				initial={{ opacity: 0, scaleY: 0 }}
				animate={{ opacity: 1, scaleY: 1 }}
				exit={{ opacity: 0, scaleY: 0, transition: { duration: 0.16, ease: "easeIn" } }}
				transition={{
					opacity: { duration: 0.15 },
					scaleY: { type: "spring", stiffness: 300, damping: 28, mass: 0.9 }
				}}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="popup-search-row">
					<svg
						className="popup-search-icon"
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="11" cy="11" r="8" />
						<line x1="21" y1="21" x2="16.65" y2="16.65" />
					</svg>
					<input
						ref={inputRef}
						type="text"
						className="popup-search-input"
						placeholder="Search apps..."
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<div className="popup-apps-scroll" ref={listRef}>
					{loading ? (
						<div aria-hidden>
							{Array.from({ length: 8 }, (_, i) => (
								<div className="popup-app-row popup-skeleton-row" key={i}>
									<div className="popup-app-icon popup-skeleton-box" />
									<div className="popup-skeleton-line" />
								</div>
							))}
						</div>
					) : flat.length > 0 ? (
						sections.map((sec) => (
							<div key={sec.title ?? "all"}>
								{sec.title && <div className="popup-section-label">{sec.title}</div>}
								{sec.items.map((app) => {
									const gi = flatIndex.get(app) ?? 0;
									const icon = listIcons[app.path];
									const alreadyPinned = pinned.some((p) => isSameApp(p, app));
									return (
										<div
											key={`${app.path}::${app.name}`}
											data-idx={gi}
											className={`popup-app-row${gi === selectedIndex ? " selected" : ""}${alreadyPinned ? " is-pinned" : ""}`}
											onClick={() => (alreadyPinned ? onClose() : onAdd(app))}
											onMouseEnter={() => setSelectedIndex(gi)}
										>
											<div className="popup-app-icon">
												{icon ? (
													<img
														key={icon}
														src={icon}
														alt=""
														draggable={false}
														style={{ opacity: 0 }}
														onLoad={(e) => {
															e.currentTarget.style.opacity = "1";
														}}
													/>
												) : (
													<span className="popup-app-initial">{app.name[0]}</span>
												)}
											</div>
											<span className="popup-app-name">{app.name}</span>
											<span className="popup-app-pin">{alreadyPinned ? "✓" : "+"}</span>
										</div>
									);
								})}
							</div>
						))
					) : (
						<div className="popup-empty">
							{debouncedSearch.trim()
								? "No results"
								: "Running apps show up here — search to pin anything else"}
						</div>
					)}
				</div>
			</motion.div>
		</div>
	);
}

export default Dock;

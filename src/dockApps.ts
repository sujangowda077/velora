export interface AppInfo {
	name: string;
	path: string;
	icon: string | null;
	is_running: boolean;
	is_pinned?: boolean;
	hwnd?: number;
	executable?: string;
	all_hwnds?: [number, string][];
	tray_ids?: string[];
	is_background?: boolean;
}

export interface TrayApp {
	name: string;
	path: string;
	tray_ids: string[];
	window_handles: number[];
}

const trayPath = (app: TrayApp) => app.path.toLowerCase().replace(/\\/g, "/");

const ownsVisibleWindow = (window: AppInfo, tray: TrayApp) =>
	(window.all_hwnds ?? (window.hwnd ? [[window.hwnd, window.name]] : [])).some(([hwnd]) =>
		tray.window_handles.includes(hwnd as number)
	);

// An unpinned notification icon becomes a dock item only after its app has
// appeared with a window. Pinned apps are eligible immediately at startup.
// Forget observed apps when their tray icon exits, so a later tray-only launch
// does not inherit a previous session's dock slot.
export function selectDockTrayApps(
	windows: AppInfo[],
	tray: TrayApp[],
	previouslyOpened: Set<string>,
	isPinned: (app: TrayApp) => boolean
): { visible: TrayApp[]; observed: Set<string> } {
	const observed = new Set<string>();
	for (const app of tray) {
		const path = trayPath(app);
		if (previouslyOpened.has(path) || windows.some((window) => ownsVisibleWindow(window, app))) {
			observed.add(path);
		}
	}
	return {
		visible: tray.filter((app) => observed.has(trayPath(app)) || isPinned(app)),
		observed
	};
}

// Associate through actual owner windows, including AUMID/PWA entries whose
// launch path differs from their executable. Never attach a tray to a different
// app just because it has the same display name or executable basename.
export function mergeTrayApps(windows: AppInfo[], tray: TrayApp[]): AppInfo[] {
	const result = windows.map((app) => ({
		...app,
		is_background: false,
		tray_ids: undefined as string[] | undefined
	}));
	for (const app of tray) {
		const owners = result.filter((item) => ownsVisibleWindow(item, app));
		if (owners.length) {
			// A browser tray can own several unrelated PWAs. Keep the running
			// items distinct and don't give any one PWA the browser's tray menu.
			if (owners.length === 1) owners[0].tray_ids = app.tray_ids;
			continue;
		}
		result.push({
			name: app.name,
			path: app.path,
			icon: null,
			is_running: true,
			is_background: true,
			all_hwnds: [],
			tray_ids: app.tray_ids,
			executable: app.path.split(/[\\/]/).pop()
		});
	}
	return result;
}

export const HOST_PROCESSES = ["msedge.exe", "chrome.exe", "brave.exe", "applicationframehost.exe"];

export function isBrowserHost(path: string) {
	const p = path.toLowerCase();
	return HOST_PROCESSES.some((host) => p.includes(host));
}

export function appIdentity(p: string, executable?: string, name?: string) {
	if (!p) return "";
	const normalized = p.toLowerCase().replace(/\\/g, "/");
	if (!normalized.includes("/")) return normalized;
	if (name && isBrowserHost(normalized)) {
		return `${normalized}:${name.toLowerCase()}`;
	}
	if (executable) return `${normalized}:${executable.toLowerCase()}`;
	return normalized;
}

export const itemKey = (app: AppInfo) => appIdentity(app.path, app.executable, app.name);

export const fileOf = (p: string) =>
	(p.split("/").pop()?.split("\\").pop()?.toLowerCase() || "").replace(/\.lnk$/, "");

export const isIdentifier = (p: string) => !p.includes("/") && !p.includes("\\");

export function isVeloraSettingsApp(app: AppInfo): boolean {
	const p = (app.path || "").toLowerCase();
	const exe = (app.executable || "").toLowerCase();
	const n = (app.name || "").toLowerCase();
	const file = (p.split("/").pop()?.split("\\").pop() || "").toLowerCase();

	if (p === "velora-settings" || p === "com.veltrex.devs.velora" || p === "com.sujan.velora") {
		return true;
	}
	if (file === "velora.exe" || exe === "velora.exe" || p.endsWith("velora.exe")) {
		return true;
	}
	if (
		(n === "settings" || n === "velora") &&
		(p.includes("velora") || exe.includes("velora") || p === "velora-settings")
	) {
		return true;
	}
	return false;
}

export function isSameApp(a: AppInfo, b: AppInfo): boolean {
	if (!a.path || !b.path) return false;
	if (itemKey(a) === itemKey(b)) return true;
	if (isVeloraSettingsApp(a) && isVeloraSettingsApp(b)) return true;
	if (isBrowserHost(a.path) || isBrowserHost(b.path)) return false;
	const aId = isIdentifier(a.path);
	const bId = isIdentifier(b.path);
	if (aId && bId) return false;
	if (aId !== bId) {
		const fileSide = aId ? b : a;
		const idLower = (aId ? a : b).path.toLowerCase();
		const na = a.name.toLowerCase();
		const nb = b.name.toLowerCase();
		if (na !== nb && !na.includes(nb) && !nb.includes(na)) return false;
		const stem = (fileSide.executable?.toLowerCase() || fileOf(fileSide.path)).replace(
			/\.(exe|lnk)$/,
			""
		);
		return stem.length >= 3 && idLower.includes(stem);
	}
	if (appIdentity(a.path) === appIdentity(b.path)) return true;
	const normExe = (s: string) => (s.endsWith(".exe") ? s : `${s}.exe`);
	const aExe = a.executable?.toLowerCase() || fileOf(a.path);
	const bExe = b.executable?.toLowerCase() || fileOf(b.path);
	if (!aExe || !bExe) return false;
	return normExe(aExe) === normExe(bExe);
}

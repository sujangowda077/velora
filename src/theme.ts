import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { reloadIfMirrorWasStale } from "./hooks/settingsMirror";

// Convert a hex color string to rgba with a specified alpha
function hexToRgba(hex: string, alpha: number): string {
	if (!hex || typeof hex !== "string") return `rgba(0, 122, 255, ${alpha})`;
	hex = hex.replace("#", "");
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((char) => char + char)
			.join("");
	}
	if (hex.length !== 6) return `rgba(0, 122, 255, ${alpha})`;
	const r = parseInt(hex.substring(0, 2), 16) || 0;
	const g = parseInt(hex.substring(2, 4), 16) || 0;
	const b = parseInt(hex.substring(4, 6), 16) || 0;
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface HSL {
	h: number;
	s: number;
	l: number;
}

// Convert Hex to HSL
export function hexToHsl(hex: string): HSL {
	if (!hex || typeof hex !== "string") {
		return { h: 211, s: 100, l: 50 };
	}
	hex = hex.replace("#", "");
	if (hex.length === 3) {
		hex = hex
			.split("")
			.map((char) => char + char)
			.join("");
	}
	if (hex.length !== 6) {
		return { h: 211, s: 100, l: 50 };
	}
	const r = (parseInt(hex.substring(0, 2), 16) || 0) / 255;
	const g = (parseInt(hex.substring(2, 4), 16) || 0) / 255;
	const b = (parseInt(hex.substring(4, 6), 16) || 0) / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	let h = 0;
	let s = 0;
	const l = (max + min) / 2;

	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case r:
				h = (g - b) / d + (g < b ? 6 : 0);
				break;
			case g:
				h = (b - r) / d + 2;
				break;
			case b:
				h = (r - g) / d + 4;
				break;
		}
		h /= 6;
	}

	return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Convert HSL back to Hex color string
function hslToHex(h: number, s: number, l: number): string {
	s /= 100;
	l /= 100;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0,
		g = 0,
		b = 0;

	if (0 <= h && h < 60) {
		r = c;
		g = x;
		b = 0;
	} else if (60 <= h && h < 120) {
		r = x;
		g = c;
		b = 0;
	} else if (120 <= h && h < 180) {
		r = 0;
		g = c;
		b = x;
	} else if (180 <= h && h < 240) {
		r = 0;
		g = x;
		b = c;
	} else if (240 <= h && h < 300) {
		r = x;
		g = 0;
		b = c;
	} else if (300 <= h && h < 360) {
		r = c;
		g = 0;
		b = x;
	}

	const toHex = (val: number) => {
		const hexVal = Math.round((val + m) * 255).toString(16);
		return hexVal.length === 1 ? "0" + hexVal : hexVal;
	};

	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export async function applyTheme(
	mode?: string,
	customColor?: string,
	opacity?: number,
	saturation?: number,
	brightness?: number
) {
	const root = document.documentElement;

	if (!mode) {
		mode = localStorage.getItem("velora-theme-mode") || "dark";
	}

	if (opacity === undefined || opacity === null || isNaN(opacity)) {
		const cachedOpacity = localStorage.getItem("velora-theme-opacity");
		opacity = cachedOpacity !== null && !isNaN(parseFloat(cachedOpacity)) ? parseFloat(cachedOpacity) : 0.8;
	}

	if (saturation === undefined || saturation === null || isNaN(saturation)) {
		const cachedSaturation = localStorage.getItem("velora-theme-saturation");
		saturation = cachedSaturation !== null && !isNaN(parseFloat(cachedSaturation)) ? parseFloat(cachedSaturation) : 0.5;
	}

	if (brightness === undefined || brightness === null || isNaN(brightness)) {
		const cachedBrightness = localStorage.getItem("velora-theme-brightness");
		brightness = cachedBrightness !== null && !isNaN(parseFloat(cachedBrightness)) ? parseFloat(cachedBrightness) : 0.15;
	}

	const color = customColor || localStorage.getItem("velora-theme-color") || "#007aff";
	const op = opacity;
	const opExpanded = Math.min(1.0, opacity + 0.12);

	if (mode === "light") {
		root.style.setProperty("--velora-bg", `rgba(255, 255, 255, ${op})`);
		root.style.setProperty("--velora-bg-expanded", `rgba(245, 245, 247, ${opExpanded})`);
		root.style.setProperty("--velora-text", "#1c1c1e");
		root.style.setProperty("--velora-text-muted", "rgba(28, 28, 30, 0.65)");
		root.style.setProperty("--velora-border", "rgba(0, 0, 0, 0.12)");
		root.style.setProperty("--velora-group-bg", "rgba(0, 0, 0, 0.04)");
		root.style.setProperty("--velora-accent", "#007aff");
		root.style.setProperty("--velora-scrollbar-thumb", "rgba(0, 0, 0, 0.15)");
		root.classList.add("light-mode");
		root.classList.remove("dark-mode");
		root.classList.add("theme-light");
		root.classList.remove("theme-dark", "theme-custom", "theme-adaptive");
	} else if (mode === "custom") {
		const hsl = hexToHsl(color);
		hsl.s = saturation * 100;
		hsl.l = brightness * 100;
		const finalBgColor = hslToHex(hsl.h, hsl.s, hsl.l);
		const isLight = brightness > 0.55;

		root.style.setProperty("--velora-bg", hexToRgba(finalBgColor, op));
		root.style.setProperty("--velora-bg-expanded", hexToRgba(finalBgColor, opExpanded));
		root.style.setProperty("--velora-text", isLight ? "#1c1c1e" : "#ffffff");
		root.style.setProperty(
			"--velora-text-muted",
			isLight ? "rgba(28, 28, 30, 0.65)" : "rgba(255, 255, 255, 0.65)"
		);
		root.style.setProperty(
			"--velora-border",
			isLight ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.12)"
		);
		root.style.setProperty(
			"--velora-group-bg",
			isLight ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.04)"
		);
		root.style.setProperty("--velora-accent", color);
		root.style.setProperty(
			"--velora-scrollbar-thumb",
			isLight ? "rgba(0, 0, 0, 0.15)" : "rgba(255, 255, 255, 0.15)"
		);
		root.classList.add("theme-custom");
		root.classList.remove("theme-light", "theme-dark", "theme-adaptive");
		if (isLight) {
			root.classList.add("light-mode");
			root.classList.remove("dark-mode");
		} else {
			root.classList.add("dark-mode");
			root.classList.remove("light-mode");
		}
	} else if (mode === "adaptive") {
		try {
			const accentHex = await invoke<string>("get_system_accent_color");
			const hsl = hexToHsl(accentHex);
			hsl.s = saturation * 100;
			hsl.l = brightness * 100;
			const finalBgColor = hslToHex(hsl.h, hsl.s, hsl.l);
			const isLight = brightness > 0.55;

			root.style.setProperty("--velora-bg", hexToRgba(finalBgColor, op));
			root.style.setProperty("--velora-bg-expanded", hexToRgba(finalBgColor, opExpanded));
			root.style.setProperty("--velora-text", isLight ? "#1c1c1e" : "#ffffff");
			root.style.setProperty(
				"--velora-text-muted",
				isLight ? "rgba(28, 28, 30, 0.65)" : "rgba(255, 255, 255, 0.65)"
			);
			root.style.setProperty(
				"--velora-border",
				isLight ? "rgba(0, 0, 0, 0.12)" : "rgba(255, 255, 255, 0.12)"
			);
			root.style.setProperty(
				"--velora-group-bg",
				isLight ? "rgba(0, 0, 0, 0.04)" : "rgba(255, 255, 255, 0.04)"
			);
			root.style.setProperty("--velora-accent", accentHex);
			root.style.setProperty(
				"--velora-scrollbar-thumb",
				isLight ? "rgba(0, 0, 0, 0.15)" : "rgba(255, 255, 255, 0.15)"
			);
			root.classList.add("theme-adaptive");
			root.classList.remove("theme-light", "theme-dark", "theme-custom");
			if (isLight) {
				root.classList.add("light-mode");
				root.classList.remove("dark-mode");
			} else {
				root.classList.add("dark-mode");
				root.classList.remove("light-mode");
			}
		} catch (e) {
			console.error("Failed to apply adaptive theme:", e);
			applyTheme("dark", color, op, saturation, brightness);
		}
	} else {
		// default/dark
		root.style.setProperty("--velora-bg", `rgba(0, 0, 0, ${op})`);
		root.style.setProperty("--velora-bg-expanded", `rgba(0, 0, 0, ${opExpanded})`);
		root.style.setProperty("--velora-text", "#ffffff");
		root.style.setProperty("--velora-text-muted", "rgba(255, 255, 255, 0.6)");
		root.style.setProperty("--velora-border", "rgba(255, 255, 255, 0.1)");
		root.style.setProperty("--velora-group-bg", "rgba(255, 255, 255, 0.04)");
		root.style.setProperty("--velora-accent", "#007aff");
		root.style.setProperty("--velora-scrollbar-thumb", "rgba(255, 255, 255, 0.1)");
		root.classList.add("dark-mode");
		root.classList.remove("light-mode");
		root.classList.add("theme-dark");
		root.classList.remove("theme-light", "theme-custom", "theme-adaptive");
	}
}

export function initTheme() {
	const syncMode = localStorage.getItem("velora-theme-mode") || "dark";
	const syncColor = localStorage.getItem("velora-theme-color") || "#007aff";
	const syncOpacityVal = localStorage.getItem("velora-theme-opacity");
	const syncOpacity = syncOpacityVal !== null && !isNaN(parseFloat(syncOpacityVal)) ? parseFloat(syncOpacityVal) : 0.8;
	const syncSaturationVal = localStorage.getItem("velora-theme-saturation");
	const syncSaturation = syncSaturationVal !== null && !isNaN(parseFloat(syncSaturationVal)) ? parseFloat(syncSaturationVal) : 0.5;
	const syncBrightnessVal = localStorage.getItem("velora-theme-brightness");
	const syncBrightness = syncBrightnessVal !== null && !isNaN(parseFloat(syncBrightnessVal)) ? parseFloat(syncBrightnessVal) : 0.15;

	// Fast synchronous draw using cached localStorage
	applyTheme(syncMode, syncColor, syncOpacity, syncSaturation, syncBrightness);

	// Sync settings.json in background to avoid flickers
	invoke<Record<string, any>>("load_settings")
		.then(async (settings) => {
			// Don't write a stale mirror value back while the window reloads.
			if (await reloadIfMirrorWasStale(settings)) return;
			const mode = settings["velora-theme-mode"] ? String(settings["velora-theme-mode"]) : syncMode;
			const color = settings["velora-theme-color"]
				? String(settings["velora-theme-color"])
				: syncColor;
			const opacityVal = settings["velora-theme-opacity"] !== undefined && !isNaN(parseFloat(String(settings["velora-theme-opacity"])))
				? parseFloat(String(settings["velora-theme-opacity"]))
				: syncOpacity;
			const saturationVal = settings["velora-theme-saturation"] !== undefined && !isNaN(parseFloat(String(settings["velora-theme-saturation"])))
				? parseFloat(String(settings["velora-theme-saturation"]))
				: syncSaturation;
			const brightnessVal = settings["velora-theme-brightness"] !== undefined && !isNaN(parseFloat(String(settings["velora-theme-brightness"])))
				? parseFloat(String(settings["velora-theme-brightness"]))
				: syncBrightness;

			if (
				mode !== syncMode ||
				color !== syncColor ||
				opacityVal !== syncOpacity ||
				saturationVal !== syncSaturation ||
				brightnessVal !== syncBrightness
			) {
				localStorage.setItem("velora-theme-mode", mode);
				localStorage.setItem("velora-theme-color", color);
				localStorage.setItem("velora-theme-opacity", String(opacityVal));
				localStorage.setItem("velora-theme-saturation", String(saturationVal));
				localStorage.setItem("velora-theme-brightness", String(brightnessVal));
				applyTheme(mode, color, opacityVal, saturationVal, brightnessVal);
			}
		})
		.catch(console.error);

	// Helper: read all theme values from localStorage and apply
	const applyThemeFromStorage = () => {
		const mode = localStorage.getItem("velora-theme-mode") || "dark";
		const color = localStorage.getItem("velora-theme-color") || "#007aff";
		const opacityVal = localStorage.getItem("velora-theme-opacity");
		const opacity = opacityVal !== null && !isNaN(parseFloat(opacityVal)) ? parseFloat(opacityVal) : 0.8;
		const saturationVal = localStorage.getItem("velora-theme-saturation");
		const saturation = saturationVal !== null && !isNaN(parseFloat(saturationVal)) ? parseFloat(saturationVal) : 0.5;
		const brightnessVal = localStorage.getItem("velora-theme-brightness");
		const brightness = brightnessVal !== null && !isNaN(parseFloat(brightnessVal)) ? parseFloat(brightnessVal) : 0.15;
		applyTheme(mode, color, opacity, saturation, brightness);
	};

	const veloraThemeKeys = [
		"velora-theme-mode",
		"velora-theme-color",
		"velora-theme-opacity",
		"velora-theme-saturation",
		"velora-theme-brightness"
	];

	// Listen to setting changes broadcasted from settings window
	const settingsPromise = listen<{ key: string; value: any }>("settings-changed", (event) => {
		const { key, value } = event.payload;
		if (veloraThemeKeys.includes(key)) {
			if (value !== null && value !== undefined) {
				localStorage.setItem(key, String(value));
			} else {
				localStorage.removeItem(key);
			}
			applyThemeFromStorage();
		}
	});

	// Listen to system accent color updates in case of adaptive theme
	const accentPromise = listen<string>("system-accent-changed", (event) => {
		const currentMode = localStorage.getItem("velora-theme-mode") || "dark";
		if (currentMode === "adaptive") {
			const opacityVal = localStorage.getItem("velora-theme-opacity");
			const opacity = opacityVal !== null && !isNaN(parseFloat(opacityVal)) ? parseFloat(opacityVal) : 0.8;
			const saturationVal = localStorage.getItem("velora-theme-saturation");
			const saturation = saturationVal !== null && !isNaN(parseFloat(saturationVal)) ? parseFloat(saturationVal) : 0.5;
			const brightnessVal = localStorage.getItem("velora-theme-brightness");
			const brightness = brightnessVal !== null && !isNaN(parseFloat(brightnessVal)) ? parseFloat(brightnessVal) : 0.15;
			applyTheme("adaptive", event.payload, opacity, saturation, brightness);
		}
	});

	// Listen to external edits (e.g. settings.json edited outside the app)
	const externalPromise = listen<{ key: string; value: any }>(
		"settings-external-changed",
		(event) => {
			const { key, value } = event.payload;
			if (veloraThemeKeys.includes(key)) {
				if (value !== null && value !== undefined) {
					localStorage.setItem(key, String(value));
				} else {
					localStorage.removeItem(key);
				}
				applyThemeFromStorage();
			}
		}
	);

	return () => {
		settingsPromise.then((f) => f());
		accentPromise.then((f) => f());
		externalPromise.then((f) => f());
	};
}

/* ==========================================================================
   Phoenix Design System - Generated TypeScript Token Helpers
   DO NOT EDIT DIRECTLY - Generated from tokens/tokens.json
   ========================================================================== */

export type SpaceToken = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "8" | "10" | "12" | "16" | "20" | "24" | "none" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "0-5" | "1-5" | "2-5";

export type RadiusToken = "none" | "sm" | "md" | "lg" | "xl" | "2xl" | "full";

export type ShadowToken = "none" | "xs" | "sm" | "md" | "lg" | "xl";

export type FontSizeToken = "xs" | "sm" | "base" | "lg" | "xl" | "2xl" | "3xl" | "4xl";

export type FontWeightToken = "thin" | "light" | "normal" | "medium" | "semibold" | "bold";

export type ZIndexToken = "base" | "dropdown" | "sticky" | "overlay" | "modal" | "popover" | "toast" | "tooltip";

export type ColorCategory = "surface" | "content" | "border" | "interactive" | "highlight" | "status" | "focus" | "danger" | "warning" | "success" | "info" | "accent" | "data";

// Token accessor helpers
export function space(value: SpaceToken): string {
  return `var(--space-${value})`;
}

export function radius(value: RadiusToken): string {
  return `var(--radius-${value})`;
}

export function shadow(value: ShadowToken): string {
  return `var(--shadow-${value})`;
}

export function fontSize(value: FontSizeToken): string {
  return `var(--font-size-${value})`;
}

export function fontWeight(value: FontWeightToken): string {
  return `var(--font-weight-${value})`;
}

export function zIndex(value: ZIndexToken): string {
  return `var(--z-${value})`;
}

// Color token helper
type ColorPath = 
  | "surface.raised"
  | "surface.canvas"
  | "surface.overlay"
  | "surface.sunken"
  | "surface.quoted"
  | "surface.quotedAlt"
  | "content.primary"
  | "content.secondary"
  | "content.muted"
  | "content.inverse"
  | "content.link"
  | "border.default"
  | "border.subtle"
  | "border.strong"
  | "border.emphasis"
  | "interactive.default"
  | "interactive.hover"
  | "interactive.muted"
  | "interactive.secondary"
  | "interactive.secondaryHover"
  | "highlight.default"
  | "highlight.bg"
  | "highlight.fg"
  | "status.queued.fg"
  | "status.queued.bg"
  | "status.running.fg"
  | "status.running.bg"
  | "status.paused.fg"
  | "status.paused.bg"
  | "status.succeeded.fg"
  | "status.succeeded.bg"
  | "status.failed.fg"
  | "status.failed.bg"
  | "status.cancelled.fg"
  | "status.cancelled.bg"
  | "status.stalled.fg"
  | "status.stalled.bg"
  | "focus.ring"
  | "focus.ringOffset"
  | "danger.default"
  | "danger.hover"
  | "danger.bg"
  | "danger.fg"
  | "warning.default"
  | "warning.hover"
  | "warning.bg"
  | "warning.fg"
  | "success.default"
  | "success.hover"
  | "success.bg"
  | "success.fg"
  | "info.default"
  | "info.hover"
  | "info.bg"
  | "info.fg"
  | "accent.default"
  | "accent.hover"
  | "accent.bg"
  | "accent.fg"
  | "data.0"
  | "data.1"
  | "data.2"
  | "data.3"
  | "data.4"
  | "data.5"
  | "data.6"
  | "data.7"
  | "data.8"
  | "data.9"
  | "data.$description"
;

export function color(path: ColorPath): string {
  const cssVar = path.replace(/\./g, "-");
  return `var(--color-${cssVar})`;
}

// Breakpoint tokens
export type BreakpointToken = "sm" | "md" | "lg" | "xl";

export const breakpoints: Record<BreakpointToken, number> = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
};

export type LayoutToken = "contentMaxWidth";

export function layout(value: LayoutToken): string {
  const map = {
    "contentMaxWidth": "var(--layout-content-max-width)",
  } as const satisfies Record<LayoutToken, string>;
  return map[value];
}

// Theme helper
export type Theme = "light" | "dark" | "system";

export function setTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

export function getTheme(): Theme {
  if (typeof document === "undefined") return "system";
  return (document.documentElement.getAttribute("data-theme") as Theme) ?? "system";
}

// Raw token values (for reference/tooling)
export const tokens = {
  "$schema": "https://design-tokens.org/schema.json",
  "name": "Phoenix Design System",
  "version": "4.0.0",
  "color": {
    "$description": "Semantic color tokens — monochrome foundation with warm yellow highlight and lavender accent",
    "light": {
      "surface": {
        "raised": "#4b4a4814",
        "canvas": "#ffffff75",
        "overlay": "#0000000a",
        "sunken": "#ffffff4f",
        "quoted": "#ffffff",
        "quotedAlt": "#ece7dd"
      },
      "content": {
        "primary": "#000000",
        "secondary": "#3d3d3d",
        "muted": "#727272",
        "inverse": "#ffffff",
        "link": "#22b5c6"
      },
      "border": {
        "default": "#ffffff85",
        "subtle": "#ffffff61",
        "strong": "#212120",
        "emphasis": "#808080"
      },
      "interactive": {
        "default": "#000000",
        "hover": "#1a1a1a",
        "muted": "#e6ddcb",
        "secondary": "#555555",
        "secondaryHover": "#3d3d3d"
      },
      "highlight": {
        "default": "#d4a030",
        "bg": "#fdf6e3",
        "fg": "#9a7418"
      },
      "status": {
        "queued": {
          "fg": "#777777",
          "bg": "#f0eeea"
        },
        "running": {
          "fg": "#0a6f82",
          "bg": "#d7eef3"
        },
        "paused": {
          "fg": "#d4a030",
          "bg": "#fdf6e3"
        },
        "succeeded": {
          "fg": "#0a8f6c",
          "bg": "#c6dfd3ba"
        },
        "failed": {
          "fg": "#d43d3d",
          "bg": "#fbe5dfb0"
        },
        "cancelled": {
          "fg": "#777777",
          "bg": "#f0eeea"
        },
        "stalled": {
          "fg": "#d43d3d",
          "bg": "#fde8e8"
        }
      },
      "focus": {
        "ring": "#000000",
        "ringOffset": "#f8f7f4"
      },
      "danger": {
        "default": "#d43d3d",
        "hover": "#b82e2e",
        "bg": "#fbe5dfb0",
        "fg": "#a12222"
      },
      "warning": {
        "default": "#d4a030",
        "hover": "#be8c20",
        "bg": "#e2d5b987",
        "fg": "#9a7418"
      },
      "success": {
        "default": "#0a8f6c",
        "hover": "#07785a",
        "bg": "#c6dfd3ba",
        "fg": "#066350"
      },
      "info": {
        "default": "#555555",
        "hover": "#3d3d3d",
        "bg": "#f0eeea",
        "fg": "#2a2a2a"
      },
      "accent": {
        "default": "#150737",
        "hover": "#6a48b8",
        "bg": "#f2eefbc4",
        "fg": "#5a3da8"
      },
      "data": {
        "0": "#e6264a",
        "1": "#d4a030",
        "2": "#4a5d72",
        "3": "#1d5ee8",
        "4": "#0a8f6c",
        "5": "#7c3aed",
        "6": "#d97706",
        "7": "#d6206e",
        "8": "#0a8f82",
        "9": "#4338ca",
        "$description": "Data visualization palette — vivid, high-contrast for light backgrounds"
      }
    },
    "dark": {
      "surface": {
        "canvas": "#000",
        "raised": "#1c1e246e",
        "overlay": "#3e3c3c21",
        "sunken": "#24293082",
        "quoted": "#17191c",
        "quotedAlt": "#23272d"
      },
      "content": {
        "primary": "#d7d4c3",
        "secondary": "#a3a3a3",
        "muted": "#8c887a",
        "inverse": "#171717",
        "link": "#709ba0"
      },
      "border": {
        "default": "#212121",
        "subtle": "#4e60624d",
        "strong": "#3d3d3d",
        "emphasis": "#757575"
      },
      "interactive": {
        "default": "#d7d4c3",
        "hover": "#e8e5d4",
        "muted": "#25252542",
        "secondary": "#8a8a8a",
        "secondaryHover": "#a3a3a3"
      },
      "highlight": {
        "default": "#d4a94e",
        "bg": "#2a2210",
        "fg": "#e8c570"
      },
      "status": {
        "queued": {
          "fg": "#6b6b6b",
          "bg": "#212121"
        },
        "running": {
          "fg": "#c979ff",
          "bg": "#d175ff3d"
        },
        "paused": {
          "fg": "#d4a94e",
          "bg": "#3a2d1087"
        },
        "succeeded": {
          "fg": "#13a688",
          "bg": "#13a68826"
        },
        "failed": {
          "fg": "#ff3782",
          "bg": "#58264680"
        },
        "cancelled": {
          "fg": "#cf1158",
          "bg": "#cf11582e"
        },
        "stalled": {
          "fg": "#cf465d",
          "bg": "#cf465d28"
        }
      },
      "focus": {
        "ring": "#a3a3a3",
        "ringOffset": "#0f0f0f"
      },
      "danger": {
        "default": "#cf1158",
        "hover": "#d68585",
        "bg": "#cf11582e",
        "fg": "#e89a9a"
      },
      "warning": {
        "default": "#d4a94e",
        "hover": "#e0b960",
        "bg": "#3a2d1087",
        "fg": "#e8c570"
      },
      "success": {
        "default": "#13a688",
        "hover": "#36b89a",
        "bg": "#273c32ba",
        "fg": "#10846c"
      },
      "info": {
        "default": "#8a8a8a",
        "hover": "#a3a3a3",
        "bg": "#1e1e1e",
        "fg": "#b0b0b0"
      },
      "accent": {
        "default": "#e9d9bd",
        "hover": "#b89edf",
        "bg": "#211729d4",
        "fg": "#c4b0e6"
      },
      "data": {
        "0": "#ff4d7a",
        "1": "#ffc342",
        "2": "#8494a7",
        "3": "#60a5fa",
        "4": "#34d399",
        "5": "#a78bfa",
        "6": "#fbbf24",
        "7": "#f472b6",
        "8": "#2dd4bf",
        "9": "#818cf8",
        "$description": "Data visualization palette — brighter for dark backgrounds"
      }
    }
  },
  "space": {
    "0": "0px",
    "1": "4px",
    "2": "8px",
    "3": "16px",
    "4": "20px",
    "5": "24px",
    "6": "32px",
    "8": "64px",
    "10": "40px",
    "12": "48px",
    "16": "64px",
    "20": "80px",
    "24": "96px",
    "$description": "Spacing scale — named size slots (primary) + numeric aliases (v1 compat)",
    "none": "0px",
    "xs": "4px",
    "sm": "8px",
    "md": "12px",
    "lg": "20px",
    "xl": "24px",
    "2xl": "32px",
    "3xl": "48px",
    "4xl": "64px",
    "5xl": "80px",
    "6xl": "96px",
    "0-5": "2px",
    "1-5": "6px",
    "2-5": "10px"
  },
  "radius": {
    "$description": "Border radius tokens",
    "none": "0px",
    "sm": "4px",
    "md": "6px",
    "lg": "16px",
    "xl": "24px",
    "2xl": "32px",
    "full": "9999px"
  },
  "shadow": {
    "$description": "Box shadow tokens — subtle, desaturated",
    "none": "none",
    "xs": "0 1px 2px 0 rgb(0 0 0 / 0.03)",
    "sm": "0 1px 3px 0 rgb(0 0 0 / 0.04), 0 1px 2px -1px rgb(0 0 0 / 0.03)",
    "md": "0 4px 6px -1px rgb(0 0 0 / 0.06), 0 2px 4px -2px rgb(0 0 0 / 0.04)",
    "lg": "0 10px 15px -3px rgb(0 0 0 / 0.06), 0 4px 6px -4px rgb(0 0 0 / 0.03)",
    "xl": "0 20px 25px -5px rgb(0 0 0 / 0.06), 0 8px 10px -6px rgb(0 0 0 / 0.03)"
  },
  "font": {
    "$description": "Typography tokens",
    "family": {
      "sans": "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "mono": "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      "title": "var(--font-lato), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    },
    "size": {
      "xs": "11px",
      "sm": "12px",
      "base": "14px",
      "lg": "18px",
      "xl": "22px",
      "2xl": "28px",
      "3xl": "36px",
      "4xl": "48px"
    },
    "weight": {
      "thin": "100",
      "light": "300",
      "normal": "400",
      "medium": "500",
      "semibold": "600",
      "bold": "700"
    },
    "lineHeight": {
      "none": "1",
      "tight": "1.25",
      "snug": "1.375",
      "normal": "1.5",
      "relaxed": "1.625"
    },
    "letterSpacing": {
      "tight": "-0.02em",
      "normal": "0",
      "wide": "0.12em",
      "wider": "0.24em"
    }
  },
  "zIndex": {
    "$description": "Z-index scale",
    "base": "0",
    "dropdown": "100",
    "sticky": "200",
    "overlay": "300",
    "modal": "400",
    "popover": "500",
    "toast": "600",
    "tooltip": "700"
  },
  "transition": {
    "$description": "Transition tokens — smooth, non-jarring",
    "duration": {
      "fast": "120ms",
      "normal": "200ms",
      "slow": "320ms",
      "slower": "500ms"
    },
    "timing": {
      "default": "cubic-bezier(0.25, 0.1, 0.25, 1)",
      "linear": "linear",
      "easeIn": "cubic-bezier(0.55, 0.06, 0.68, 0.19)",
      "easeOut": "cubic-bezier(0.22, 0.61, 0.36, 1)",
      "easeInOut": "cubic-bezier(0.4, 0, 0.2, 1)",
      "spring": "cubic-bezier(0.34, 1.56, 0.64, 1)"
    }
  },
  "layout": {
    "$description": "Page and content width — use for primary app columns aligned with PageContainer",
    "contentMaxWidth": "1100px"
  }
} as const;

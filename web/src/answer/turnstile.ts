import { TURNSTILE_SITE_KEY } from "../config";

// https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
const SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface Turnstile {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      appearance: "always" | "execute" | "interaction-only";
      callback: (token: string) => void;
      "error-callback": () => void;
      "before-interactive-callback": () => void;
      "after-interactive-callback": () => void;
    },
  ): string;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let script: Promise<Turnstile> | null = null;

function loadTurnstile(): Promise<Turnstile> {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT;
    el.onload = () =>
      window.turnstile
        ? resolve(window.turnstile)
        : reject(new Error("Turnstile did not load"));
    el.onerror = () => reject(new Error("Turnstile did not load"));
    document.head.append(el);
  }).catch((err: unknown) => {
    script = null; // retry next time
    throw err;
  });
  return script;
}

/**
 * Runs a Turnstile challenge in `container` and resolves with its one-time
 * token. The widget stays invisible unless the visitor must interact, which
 * `onInteractive(true)` reports.
 */
export async function turnstileToken(
  container: HTMLElement,
  onInteractive: (active: boolean) => void,
): Promise<string> {
  const ts = await loadTurnstile();
  return new Promise((resolve, reject) => {
    const id = ts.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => {
        resolve(token);
        setTimeout(() => ts.remove(id));
      },
      "before-interactive-callback": () => onInteractive(true),
      "after-interactive-callback": () => onInteractive(false),
      "error-callback": () => {
        reject(new Error("Turnstile challenge failed"));
        setTimeout(() => ts.remove(id));
      },
    });
  });
}

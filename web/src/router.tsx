// A minimal History-API router: four routes don't need a routing library.
// The Worker serves index.html for every non-asset path (SPA fallback).
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  useSyncExternalStore,
} from "react";

const subscribe = (onChange: () => void) => {
  addEventListener("popstate", onChange);
  return () => removeEventListener("popstate", onChange);
};

export const usePath = () =>
  useSyncExternalStore(subscribe, () => location.pathname);

export function navigate(to: string) {
  if (to === location.pathname) return;
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
  scrollTo(0, 0);
}

/** An in-app link: plain clicks navigate without a reload. */
export function Link({
  to,
  ...rest
}: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const path = usePath();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a
      href={to}
      onClick={onClick}
      aria-current={path === to ? "page" : undefined}
      {...rest}
    />
  );
}

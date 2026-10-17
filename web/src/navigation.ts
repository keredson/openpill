import { useSyncExternalStore, type MouseEvent } from "react";
import { sitePath } from "./sitePath";

const NAVIGATION_EVENT = "openpill:navigate";
type Route = "/" | "/flash" | "/restore";

function currentRoute() {
  const base = import.meta.env.BASE_URL;
  const path = window.location.pathname.startsWith(base)
    ? window.location.pathname.slice(base.length).replace(/\/$/, "")
    : "";
  return path === "flash" || path === "restore" ? `/${path}` : "/";
}

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener(NAVIGATION_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(NAVIGATION_EVENT, callback);
  };
}

export function useRoute() {
  return useSyncExternalStore(subscribe, currentRoute);
}

export function routeUrl(path: Route): string {
  return sitePath(path === "/" ? "" : `${path.slice(1)}/`);
}

export function navigate(path: Route) {
  if (currentRoute() === path) return;
  window.history.pushState(null, "", routeUrl(path));
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
  window.scrollTo(0, 0);
}

export function handleInternalLink(event: MouseEvent<HTMLAnchorElement>, path: Route) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

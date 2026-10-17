import { useSyncExternalStore, type MouseEvent } from "react";

const NAVIGATION_EVENT = "openpill:navigate";

function currentRoute() {
  const path = window.location.pathname.replace(/\/$/, "");
  return path === "/flash" || path === "/restore" ? path : "/";
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

export function navigate(path: "/" | "/flash" | "/restore") {
  if (currentRoute() === path) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
  window.scrollTo(0, 0);
}

export function handleInternalLink(event: MouseEvent<HTMLAnchorElement>, path: "/" | "/flash" | "/restore") {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

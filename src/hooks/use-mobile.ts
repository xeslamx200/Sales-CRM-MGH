import * as React from "react"

// Below this width the sidebar is a slide-over menu (phones AND tablets: on a 768-1023px screen a fixed sidebar left too little room
// for the content). Must match the lg: classes in src/components/ui/sidebar.tsx.
const MOBILE_BREAKPOINT = 1024
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  )
}

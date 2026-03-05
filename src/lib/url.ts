export function normalizeMetaText(value: string | undefined | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeSlug(urlString: string): string {
  const url = new URL(urlString);
  const path = url.pathname.toLowerCase();
  if (path === "/") {
    return "/";
  }
  return path.replace(/\/+$/, "");
}

export function normalizeDedupeLink(urlString: string): string {
  const url = new URL(urlString);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function resolveHref(baseUrl: string, href: string): string | null {
  try {
    if (!href || href.startsWith("javascript:")) {
      return null;
    }

    if (href.startsWith("mailto:") || href.startsWith("tel:")) {
      return null;
    }

    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

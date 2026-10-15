// UI validation only; successful validation is never upload authorization.
export function createUploadDestinationGuard({ getDomain, getDomains, isConfigured,
  requiresRelay, verifyRelay, onIssue }) {
  return async provider => {
    if (!["r2", "filebase"].includes(provider)) return null;
    const domain = getDomain(provider);
    let issue = "";
    if (!domain || !getDomains(provider).includes(domain)) issue = "domain";
    else {
      try {
        const url = new URL(domain);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
            (url.pathname !== "/" && url.pathname !== "")) issue = "domain";
      } catch (_) { issue = "domain"; }
    }
    if (!issue && !isConfigured(provider)) issue = "storage";
    if (!issue && requiresRelay(domain)) {
      try { if (!await verifyRelay(domain)) issue = "relay"; }
      catch (_) { issue = "relay"; }
    }
    if (issue) { await onIssue(provider, issue); return null; }
    return Object.freeze({ provider, domain });
  };
}

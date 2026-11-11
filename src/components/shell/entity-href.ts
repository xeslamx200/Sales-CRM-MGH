/** Link target for an entity referenced by a notification or search result. */
export function entityHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case "lead": return `/leads/${id}`;
    case "contact": return `/contacts/${id}`;
    case "task": return "/tasks";
    case "conversation": return `/inbox?c=${id}`;
    case "whatsapp_account": return "/admin/whatsapp";
    default: return null;
  }
}

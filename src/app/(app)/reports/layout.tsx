import { getViewer, guardSection } from "@/server/auth/viewer";

/** A custom role can hide this section: its pages then answer "not found" (see company_roles.hidden_nav). */
export default async function SectionLayout({ children }: { children: React.ReactNode }) {
  guardSection(await getViewer(), "/reports");
  return children;
}

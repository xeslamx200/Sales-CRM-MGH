import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/states";
import { requestI18n } from "@/server/i18n";

/** notFound() inside the app shell: rendered within the layout's <main>, so no landmark of its own. */
export default async function AppNotFound() {
  const { t } = await requestI18n();
  return (
    <EmptyState
      icon={FileQuestion}
      title={t.common.notFoundTitle}
      titleAs="h1"
      description={t.common.notFoundBody}
      action={<Button asChild><Link href="/">{t.common.goHome}</Link></Button>}
      className="my-auto"
    />
  );
}

import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/states";
import { requestI18n } from "@/server/i18n";

export default async function NotFound() {
  const { t } = await requestI18n();
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <EmptyState
        icon={FileQuestion}
        title={t.common.notFoundTitle}
        titleAs="h1"
        description={t.common.notFoundBody}
        action={<Button asChild><Link href="/">{t.common.goHome}</Link></Button>}
      />
    </main>
  );
}

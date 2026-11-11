"use client";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/app/dialogs";
import { useI18n } from "@/components/i18n-provider";
import { dismissDuplicate, mergeContacts } from "@/actions/contacts";
import { fmt } from "@/i18n";

type C = { id: string; name: string };

/** Merging is irreversible and needs admin rights in every linked company (DB rule). */
export function DuplicateActions({ reviewId, a, b }: { reviewId: string; a: C; b: C }) {
  const { t } = useI18n();
  const merge = (keep: C, drop: C) => (
    <ConfirmDialog
      trigger={<Button size="sm" variant="outline">{fmt(t.duplicates.keep, { name: keep.name })}</Button>}
      title={t.duplicates.mergeTitle}
      description={fmt(t.duplicates.mergeConfirm, { keep: keep.name, drop: drop.name })}
      confirmLabel={t.duplicates.merge}
      destructive
      onConfirm={() => mergeContacts({ keepId: keep.id, mergeId: drop.id })}
      successMessage={t.duplicates.merged}
    />
  );
  return (
    <div className="mt-3 flex flex-wrap justify-end gap-2">
      {merge(a, b)}
      {merge(b, a)}
      <ConfirmDialog
        trigger={<Button size="sm" variant="ghost">{t.duplicates.dismiss}</Button>}
        title={t.duplicates.dismiss}
        description={t.duplicates.dismissConfirm}
        onConfirm={() => dismissDuplicate({ reviewId })}
        successMessage={t.common.saved}
      />
    </div>
  );
}

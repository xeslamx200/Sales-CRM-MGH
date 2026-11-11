"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FormError, SubmitButton, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { makeNewPasswordSchema } from "@/schemas/auth";
import { updatePassword } from "@/actions/auth";

/** Reached from the recovery e-mail via /auth/confirm (which created the session). */
export default function ResetPasswordPage() {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  const schema = useMemo(() => makeNewPasswordSchema(t.auth.passwordMismatch), [t]);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { password: "", confirm: "" },
    action: updatePassword,
    onSuccess: () => setDone(true),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.auth.resetTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="flex flex-col gap-4">
            <Alert>
              <CheckCircle2 />
              <AlertDescription>{t.auth.passwordUpdated}</AlertDescription>
            </Alert>
            <Link href="/" className="text-center text-sm text-primary hover:underline">{t.common.goHome}</Link>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <FieldGroup>
              <FormError message={form.formState.errors.root?.message} />
              <TextField control={form.control} name="password" type="password" label={t.auth.newPassword}
                autoComplete="new-password" description={t.auth.passwordTooShort} />
              <TextField control={form.control} name="confirm" type="password" label={t.auth.confirmPassword}
                autoComplete="new-password" />
              <SubmitButton pending={pending} className="w-full">{t.common.save}</SubmitButton>
            </FieldGroup>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

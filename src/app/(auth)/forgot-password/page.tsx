"use client";
import { useState } from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FormError, SubmitButton, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { emailSchema } from "@/schemas/auth";
import { requestPasswordReset } from "@/actions/auth";

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const { form, submit, pending } = useActionForm({
    schema: emailSchema,
    defaultValues: { email: "" },
    action: requestPasswordReset,
    onSuccess: () => setSent(true),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.auth.forgotTitle}</CardTitle>
        <CardDescription>{t.auth.forgotSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        {sent ? (
          <Alert>
            <MailCheck />
            <AlertDescription>{t.auth.linkSent}</AlertDescription>
          </Alert>
        ) : (
          <form onSubmit={submit} noValidate>
            <FieldGroup>
              <FormError message={form.formState.errors.root?.message} />
              <TextField control={form.control} name="email" type="email" label={t.auth.email} autoComplete="username" />
              <SubmitButton pending={pending} className="w-full">{t.auth.sendLink}</SubmitButton>
            </FieldGroup>
          </form>
        )}
        <Link href="/login" className="mt-4 block text-center text-sm text-muted-foreground hover:text-primary hover:underline">
          {t.auth.backToSignIn}
        </Link>
      </CardContent>
    </Card>
  );
}

"use client";
import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormError, SubmitButton, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { makeAcceptInviteSchema } from "@/schemas/auth";
import { acceptInvite } from "@/actions/auth";

export function AcceptInviteForm({ email, fullName }: { email: string; fullName: string }) {
  const { t } = useI18n();
  const schema = useMemo(() => makeAcceptInviteSchema(t.auth.passwordMismatch), [t]);
  const { form, submit, pending } = useActionForm({
    schema,
    defaultValues: { fullName, password: "", confirm: "" },
    action: acceptInvite,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.auth.inviteTitle}</CardTitle>
        <CardDescription>{t.auth.inviteSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate>
          <FieldGroup>
            <FormError message={form.formState.errors.root?.message} />
            <Field>
              <FieldLabel htmlFor="invite-email">{t.auth.email}</FieldLabel>
              <Input id="invite-email" value={email} readOnly disabled dir="ltr" />
            </Field>
            <TextField control={form.control} name="fullName" label={t.common.fullName} autoComplete="name" />
            <TextField control={form.control} name="password" type="password" label={t.auth.newPassword}
              autoComplete="new-password" description={t.auth.passwordTooShort} />
            <TextField control={form.control} name="confirm" type="password" label={t.auth.confirmPassword}
              autoComplete="new-password" />
            <SubmitButton pending={pending} className="w-full">{t.auth.activate}</SubmitButton>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

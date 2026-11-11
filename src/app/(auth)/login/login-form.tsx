"use client";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { FormError, SubmitButton, TextField } from "@/components/form/fields";
import { useActionForm } from "@/components/form/use-action-form";
import { useI18n } from "@/components/i18n-provider";
import { signInSchema } from "@/schemas/auth";
import { signIn } from "@/actions/auth";

export function LoginForm({ next, notice }: { next?: string; notice?: string }) {
  const { t } = useI18n();
  const { form, submit, pending } = useActionForm({
    schema: signInSchema,
    defaultValues: { email: "", password: "", next },
    action: signIn,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.auth.signInTitle}</CardTitle>
        <CardDescription>{t.auth.signInSubtitle}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate>
          <FieldGroup>
            <FormError message={form.formState.errors.root?.message ?? notice} />
            <TextField control={form.control} name="email" type="email" label={t.auth.email} autoComplete="username" />
            <TextField control={form.control} name="password" type="password" label={t.auth.password}
              autoComplete="current-password" />
            <SubmitButton pending={pending} pendingLabel={t.auth.signingIn} className="w-full">
              {t.auth.signIn}
            </SubmitButton>
            <Link href="/forgot-password" className="text-center text-sm text-muted-foreground hover:text-primary hover:underline">
              {t.auth.forgotLink}
            </Link>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

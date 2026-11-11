"use client";
import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";
import { AlertCircle, Loader2 } from "lucide-react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";

type Base<T extends FieldValues> = {
  control: Control<T>;
  name: Path<T>;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
};

export function TextField<T extends FieldValues>({
  control, name, label, description, disabled, className, type = "text", placeholder, autoComplete, dir, inputMode,
}: Base<T> & {
  type?: "text" | "email" | "password" | "tel" | "number" | "date" | "datetime-local" | "url";
  placeholder?: string;
  autoComplete?: string;
  dir?: "ltr" | "rtl" | "auto";
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Input
            id={name}
            type={type}
            placeholder={placeholder}
            autoComplete={autoComplete}
            inputMode={inputMode}
            dir={dir ?? (type === "email" || type === "tel" || type === "url" ? "ltr" : undefined)}
            disabled={disabled}
            aria-invalid={fieldState.invalid}
            {...field}
            value={field.value ?? ""}
          />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export function TextareaField<T extends FieldValues>({
  control, name, label, description, disabled, className, rows = 3, placeholder,
}: Base<T> & { rows?: number; placeholder?: string }) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Textarea id={name} rows={rows} placeholder={placeholder} disabled={disabled}
            aria-invalid={fieldState.invalid} {...field} value={field.value ?? ""} />
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export type Option = { value: string; label: string };
const NONE = "__none__";

/** Select bound to a string | null value. `emptyLabel` adds a "none" choice that maps to null. */
export function SelectField<T extends FieldValues>({
  control, name, label, description, disabled, className, options, emptyLabel, placeholder,
}: Base<T> & { options: Option[]; emptyLabel?: string; placeholder?: string }) {
  const { t } = useI18n();
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid} className={className}>
          <FieldLabel htmlFor={name}>{label}</FieldLabel>
          <Select
            disabled={disabled}
            value={field.value == null || field.value === "" ? (emptyLabel ? NONE : "") : String(field.value)}
            onValueChange={(v) => field.onChange(v === NONE ? null : v)}
          >
            <SelectTrigger id={name} aria-invalid={fieldState.invalid} className="w-full">
              <SelectValue placeholder={placeholder ?? t.common.selectPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {emptyLabel && <SelectItem value={NONE}>{emptyLabel}</SelectItem>}
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FieldDescription>{description}</FieldDescription>}
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </Field>
      )}
    />
  );
}

export function CheckboxField<T extends FieldValues>({ control, name, label, description, disabled, className }: Base<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field orientation="horizontal" data-invalid={fieldState.invalid} className={className}>
          <Checkbox id={name} checked={Boolean(field.value)} onCheckedChange={(v) => field.onChange(v === true)}
            disabled={disabled} />
          <FieldLabel htmlFor={name} className="font-normal">{label}</FieldLabel>
          {description && <FieldDescription>{description}</FieldDescription>}
        </Field>
      )}
    />
  );
}

/** Form-level error (already localized by the server). */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function SubmitButton({
  pending, children, className, pendingLabel, disabled,
}: { pending: boolean; children: React.ReactNode; className?: string; pendingLabel?: string; disabled?: boolean }) {
  const { t } = useI18n();
  return (
    <Button type="submit" disabled={pending || disabled} className={cn(className)}>
      {pending && <Loader2 className="animate-spin" />}
      {pending ? (pendingLabel ?? t.common.saving) : children}
    </Button>
  );
}

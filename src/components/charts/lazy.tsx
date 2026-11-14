"use client";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The charts use recharts (~360 KB of JavaScript to parse). They are loaded AFTER the page is interactive, with a placeholder of about the same
 * height, so the dashboard and the reports open and respond first (this matters most on phones, where parsing that file blocked the page for seconds).
 */
const placeholder = (h: string) => function Placeholder() { return <Skeleton className={`w-full rounded-xl ${h}`} aria-hidden />; };

export const LazyRevenueHero = dynamic<ComponentProps<typeof import("@/components/dashboard/revenue-hero").RevenueHero>>(
  () => import("@/components/dashboard/revenue-hero").then((m) => m.RevenueHero), { ssr: false, loading: placeholder("h-[26rem]") });

export const LazyLeadsPerDayChart = dynamic<ComponentProps<typeof import("@/components/reports/leads-per-day-chart").LeadsPerDayChart>>(
  () => import("@/components/reports/leads-per-day-chart").then((m) => m.LeadsPerDayChart), { ssr: false, loading: placeholder("h-80") });

export const LazyDailyCharts = dynamic<ComponentProps<typeof import("@/components/reports/daily-charts").DailyCharts>>(
  () => import("@/components/reports/daily-charts").then((m) => m.DailyCharts), { ssr: false, loading: placeholder("h-[34rem]") });

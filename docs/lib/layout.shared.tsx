import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { i18n } from "@/lib/i18n";

export function baseOptions(locale: string): BaseLayoutProps {
  const titles: Record<string, string> = {
    en: "Custom-MCPs",
    zh: "Custom-MCPs",
    es: "Custom-MCPs",
    ja: "Custom-MCPs",
  };

  const docsLabels: Record<string, string> = {
    en: "Documentation",
    zh: "文档",
    es: "Documentación",
    ja: "ドキュメント",
  };

  return {
    i18n,
    nav: {
      title: titles[locale] ?? titles.en,
      url: `/${locale}`,
    },
    links: [
      {
        type: "main",
        text: docsLabels[locale] ?? docsLabels.en,
        url: `/${locale}/docs`,
      },
    ],
  };
}

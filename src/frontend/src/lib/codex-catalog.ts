export type CodexCatalogEffort = {
  slug: string;
  label: string;
  isDefault: boolean;
};

export type CodexCatalogModel = {
  slug: string;
  label: string;
  description: string;
  defaultReasoningEffort: string;
  reasoningEfforts: CodexCatalogEffort[];
};

export type CodexCatalog = { models: CodexCatalogModel[] };

export function modelForSlug(catalog: CodexCatalog, slug: string) {
  return catalog.models.find((model) => model.slug === slug);
}

export function reasoningEffortForModel(catalog: CodexCatalog, modelSlug: string, currentEffort: string) {
  const model = modelForSlug(catalog, modelSlug);
  if (!model) return currentEffort;
  return model.reasoningEfforts.some((effort) => effort.slug === currentEffort)
    ? currentEffort
    : model.defaultReasoningEffort;
}

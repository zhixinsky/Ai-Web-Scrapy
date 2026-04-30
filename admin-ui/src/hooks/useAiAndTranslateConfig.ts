import { useEffect, useState } from 'react';

import { api, type CollectionAiPromptSettings } from '../api';

export function useAiAndTranslateConfig({
  detailId,
  aiPromptPlatformKey,
}: {
  detailId: number;
  aiPromptPlatformKey: string | null | undefined;
}) {
  const [mimoConfigured, setMimoConfigured] = useState<boolean | null>(null);
  const [tencentTranslateConfigured, setTencentTranslateConfigured] = useState<boolean | null>(
    null
  );
  const [aiPrompts, setAiPrompts] = useState<CollectionAiPromptSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMimoConfigured(null);
    setTencentTranslateConfigured(null);
    setAiPrompts(null);
    const platformKey =
      String(aiPromptPlatformKey || 'amazon').trim().toLowerCase() || 'amazon';

    api
      .mimoStatus()
      .then((r) => {
        if (!cancelled) setMimoConfigured(r.configured);
      })
      .catch(() => {
        if (!cancelled) setMimoConfigured(false);
      });

    api
      .tencentTranslateStatus()
      .then((r) => {
        if (!cancelled) setTencentTranslateConfigured(r.configured);
      })
      .catch(() => {
        if (!cancelled) setTencentTranslateConfigured(false);
      });

    api
      .collectionAiPrompts(platformKey)
      .then((r) => {
        if (!cancelled) setAiPrompts(r);
      })
      .catch(() => {
        if (!cancelled) setAiPrompts(null);
      });

    return () => {
      cancelled = true;
    };
  }, [detailId, aiPromptPlatformKey]);

  return { mimoConfigured, tencentTranslateConfigured, aiPrompts };
}


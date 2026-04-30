import { useCallback, useEffect, useRef, useState } from 'react';

export type ImageLightboxState = { urls: string[]; index: number } | null;

export function useCollectionImageLightbox({
  detailId,
  imagesStatus,
  imagesManifestMainLen,
  imagesManifestGalleryFiles,
  galleryLen,
  galleryUrls,
  detailLen,
  showLocalDetail,
  detailImageUrls,
}: {
  detailId: number;
  imagesStatus: string | null | undefined;
  imagesManifestMainLen: number;
  imagesManifestGalleryFiles: string[];
  galleryLen: number;
  galleryUrls: string[];
  detailLen: number;
  showLocalDetail: boolean;
  detailImageUrls: string[];
}) {
  const [lightbox, setLightbox] = useState<ImageLightboxState>(null);

  const mainBlobUrlsRef = useRef<string[]>([]);
  const galleryBlobUrlsRef = useRef<string[]>([]);
  const detailBlobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    mainBlobUrlsRef.current = new Array(imagesManifestMainLen).fill('');
  }, [detailId, imagesManifestMainLen]);

  useEffect(() => {
    galleryBlobUrlsRef.current = new Array(galleryLen).fill('');
  }, [detailId, galleryLen]);

  useEffect(() => {
    detailBlobUrlsRef.current = new Array(detailLen).fill('');
  }, [detailId, detailLen]);

  const registerMainBlob = useCallback((index: number, url: string) => {
    const a = mainBlobUrlsRef.current;
    if (index >= 0 && index < a.length) a[index] = url;
  }, []);

  const registerGalleryBlob = useCallback((index: number, url: string) => {
    const a = galleryBlobUrlsRef.current;
    if (index >= 0 && index < a.length) a[index] = url;
  }, []);

  const registerDetailBlob = useCallback((index: number, url: string) => {
    const a = detailBlobUrlsRef.current;
    if (index >= 0 && index < a.length) a[index] = url;
  }, []);

  const openMainLightbox = useCallback(
    (i: number) => {
      const len = imagesManifestMainLen;
      const ordered = [...mainBlobUrlsRef.current];
      while (ordered.length < len) ordered.push('');
      if (!ordered[i]) return;
      const urls = ordered.filter(Boolean);
      let pos = -1;
      let c = 0;
      for (let j = 0; j < ordered.length; j++) {
        if (!ordered[j]) continue;
        if (j === i) {
          pos = c;
          break;
        }
        c++;
      }
      if (pos < 0) return;
      setLightbox({ urls, index: pos });
    },
    [imagesManifestMainLen]
  );

  const openGalleryLightbox = useCallback(
    (i: number) => {
      const galleryLocalFiles = imagesManifestGalleryFiles;
      const ordered = new Array(galleryLen).fill('').map((_, j) => {
        const u = galleryUrls[j] || '';
        const hasLocal = imagesStatus === 'done' && Boolean(galleryLocalFiles[j]);
        if (hasLocal) return galleryBlobUrlsRef.current[j] || '';
        return u || '';
      });
      if (!ordered[i]) return;
      const urls = ordered.filter(Boolean);
      let pos = -1;
      let c = 0;
      for (let j = 0; j < ordered.length; j++) {
        if (!ordered[j]) continue;
        if (j === i) {
          pos = c;
          break;
        }
        c++;
      }
      if (pos < 0) return;
      setLightbox({ urls, index: pos });
    },
    [galleryLen, galleryUrls, imagesManifestGalleryFiles, imagesStatus]
  );

  const openDetailImagesLightbox = useCallback(
    (i: number) => {
      const ordered = new Array(detailLen).fill('').map((_, j) => {
        if (showLocalDetail) return detailBlobUrlsRef.current[j] || '';
        return String(detailImageUrls[j] || '').trim();
      });
      if (!ordered[i]) return;
      const urls = ordered.filter(Boolean);
      let pos = -1;
      let c = 0;
      for (let j = 0; j < ordered.length; j++) {
        if (!ordered[j]) continue;
        if (j === i) {
          pos = c;
          break;
        }
        c++;
      }
      if (pos < 0) return;
      setLightbox({ urls, index: pos });
    },
    [detailImageUrls, detailLen, showLocalDetail]
  );

  const closeLightbox = useCallback(() => setLightbox(null), []);

  return {
    lightbox,
    closeLightbox,
    registerMainBlob,
    registerGalleryBlob,
    registerDetailBlob,
    openMainLightbox,
    openGalleryLightbox,
    openDetailImagesLightbox,
  };
}


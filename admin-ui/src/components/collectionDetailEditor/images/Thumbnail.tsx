export function Thumbnail({ url, onOpen }: { url: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen()}
      className="app-image-thumb-button group shrink-0 rounded-lg border border-slate-200 bg-white p-1 shadow-sm transition hover:border-teal-300 hover:shadow"
      title={url}
    >
      <div className="relative h-24 w-24 overflow-hidden rounded-md bg-slate-100">
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.opacity = '0.35';
          }}
        />
      </div>
    </button>
  );
}


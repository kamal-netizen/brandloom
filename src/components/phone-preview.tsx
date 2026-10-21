/* eslint-disable @next/next/no-img-element -- renditions are already Instagram-sized JPEGs; the optimizer would only re-encode them */
import { cn } from "./ui";

/** How the post will look on a phone: feed card (4:5) or full-screen story (9:16). */
export function PhonePreview({
  type,
  imageUrl,
  caption,
  handle,
  className,
}: {
  type: string;
  imageUrl: string | null;
  caption: string;
  handle: string | null;
  className?: string;
}) {
  const name = handle ? handle.replace(/^@/, "") : "brand";
  if (type === "STORY" || type === "REEL") {
    const video = imageUrl && (/\.(mp4|mov)(\?|$)/i.test(imageUrl) || imageUrl.startsWith("blob:") && type === "REEL");
    return (
      <div className={cn("relative mx-auto aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-[28px] border-4 border-zinc-800 bg-black", className)}>
        {video ? (
          <video src={imageUrl!} className="h-full w-full object-cover" muted loop autoPlay playsInline />
        ) : imageUrl ? (
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <Placeholder />
        )}
        <div className="absolute inset-x-3 top-3 h-0.5 rounded bg-white/50" />
        <div className="absolute left-3 top-6 flex items-center gap-2 text-xs font-semibold text-white drop-shadow">
          <span className="h-6 w-6 rounded-full bg-white/30" />
          {name}
        </div>
        {/* Instagram's own UI covers roughly the top 250 and bottom 340 px of 1920 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[13%] border-b border-dashed border-white/25" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[17.7%] border-t border-dashed border-white/25" />
      </div>
    );
  }
  const [first, ...rest] = caption.split("\n");
  return (
    <div className={cn("mx-auto w-full max-w-[340px] overflow-hidden rounded-2xl border border-line bg-black text-[13px]", className)}>
      <div className="flex items-center gap-2 px-3 py-2.5 font-semibold">
        <span className="h-7 w-7 rounded-full bg-gradient-to-tr from-amber-400 via-pink-500 to-violet-600 p-[2px]">
          <span className="block h-full w-full rounded-full bg-zinc-800" />
        </span>
        {name}
      </div>
      <div className="aspect-[4/5] w-full bg-zinc-900">{imageUrl ? <img src={imageUrl} alt="" className="h-full w-full object-cover" /> : <Placeholder />}</div>
      <div className="space-y-1 px-3 py-3 leading-snug">
        <p className="whitespace-pre-line">
          <span className="font-semibold">{name}</span> {first}
          {rest.length > 0 && <span className="text-zinc-400">{"\n" + rest.join("\n")}</span>}
        </p>
      </div>
    </div>
  );
}

function Placeholder() {
  return <div className="grid h-full w-full place-items-center text-xs text-zinc-600">No image yet</div>;
}

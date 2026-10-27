/**
 * The Arato Legal emblem, from the Arato Legal design system (Logo Masters).
 * Green on light surfaces and cream on dark ones; the dark variant follows the
 * app's `.dark` class. Decorative: the firm's name is the text beside it.
 */
export function AratoEmblem({
    size = 22,
    className = "",
}: {
    size?: number;
    className?: string;
}) {
    const box = { width: size, height: size };
    return (
        <span
            aria-hidden="true"
            className={`inline-block shrink-0 ${className}`}
            style={box}
        >
            {/* eslint-disable-next-line @next/next/no-img-element -- a small static SVG */}
            <img
                src="/brand/arato-emblem-green.svg"
                alt=""
                draggable={false}
                className="block dark:hidden"
                style={box}
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- a small static SVG */}
            <img
                src="/brand/arato-emblem-cream.svg"
                alt=""
                draggable={false}
                className="hidden dark:block"
                style={box}
            />
        </span>
    );
}

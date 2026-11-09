// The top of every screen: a small line saying what's shown, the headline in a sentence,
// and a quiet line of figures. Takes the place of rows of number tiles.

import type { ReactNode } from "react";

/** A figure inside a headline: set in the mono face, like the rest of the numbers. */
export const Fig = ({ children }: { children: ReactNode }) => <span className="fig">{children}</span>;

export default function Lede({
  eyebrow,
  stats = [],
  actions,
  children,
}: {
  eyebrow: string;
  stats?: (string | null | false)[];
  actions?: ReactNode;
  children: ReactNode;
}) {
  const shown = stats.filter((s): s is string => !!s);
  return (
    <header className="lede">
      <div className="lede-text">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{children}</h1>
        {shown.length > 0 && <p className="stats">{shown.join(" · ")}</p>}
      </div>
      {actions && <div className="lede-actions">{actions}</div>}
    </header>
  );
}

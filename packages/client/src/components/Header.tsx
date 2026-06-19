/**
 * Header — ported from original App.js header section.
 * Includes logo, title, nav tabs, player picker, and play controls.
 */

type View = 'play' | 'agents' | 'history' | 'lobby';

interface HeaderProps {
  activeView: View;
  onNavigate: (view: View) => void;
  onReset?: () => void;
  onPlay?: () => void;
  onPause?: () => void;
  onStep?: () => void;
}

const NAV_ITEMS: { view: View; label: string }[] = [
  { view: 'play', label: 'Play' },
  { view: 'agents', label: 'Agents' },
  { view: 'history', label: 'History' },
  { view: 'lobby', label: 'Lobby' },
];

export default function Header({
  activeView, onNavigate,
  onReset, onPlay, onPause, onStep,
}: HeaderProps) {
  return (
    <div id="header">
      <div id="header-container">
        <a href="https://www.finitygame.com/" target="_blank" rel="noreferrer">
          <img src="img/FinityLogo50trans-01.png" alt="Finity Logo" id="finity-logo" />
        </a>
        <span id="title">Finity AI Playground</span>

        {/* Navigation tabs */}
        <nav className="header-nav">
          {NAV_ITEMS.map(({ view, label }) => (
            <button
              key={view}
              className={`nav-btn ${activeView === view ? 'nav-active' : ''}`}
              onClick={() => onNavigate(view)}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Play controls */}
        <div id="controls">
          <ControlButton
            outlineImg="img/noun-reset-outline.png"
            solidImg="img/noun-reset-solid.png"
            alt="reset"
            onClick={onReset}
          />
          <ControlButton
            outlineImg="img/noun-play-outline.png"
            solidImg="img/noun-play-solid.png"
            alt="play"
            onClick={onPlay}
          />
          <ControlButton
            outlineImg="img/noun-pause-outline.png"
            solidImg="img/noun-pause-solid.png"
            alt="pause"
            onClick={onPause}
          />
          <ControlButton
            outlineImg="img/noun-step-fwd-outline.png"
            solidImg="img/noun-step-fwd-solid.png"
            alt="step forward"
            onClick={onStep}
          />
          <ControlButton
            outlineImg="img/noun-step-bwd-outline.png"
            solidImg="img/noun-step-bwd-solid.png"
            alt="step back"
          />
          <ControlButton
            outlineImg="img/noun-ff-outline.png"
            solidImg="img/noun-ff-solid.png"
            alt="fast forward"
          />
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  outlineImg, solidImg, alt, onClick,
}: {
  outlineImg: string; solidImg: string; alt: string;
  onClick?: () => void;
}) {
  return (
    <div className="c-btns">
      <img
        src={outlineImg}
        height="35"
        alt={alt}
        onClick={onClick}
        onMouseDown={(e) => { (e.target as HTMLImageElement).src = solidImg; }}
        onMouseUp={(e) => { (e.target as HTMLImageElement).src = outlineImg; }}
      />
    </div>
  );
}

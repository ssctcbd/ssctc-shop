import Logo from './Logo';

/** Centered card used by both login screens. */
export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-logo">
          <Logo height={72} />
        </div>
        <h1>{title}</h1>
        {subtitle && <p className="auth-sub">{subtitle}</p>}
        {children}
      </div>
      {footer && <p className="auth-footer">{footer}</p>}
    </main>
  );
}

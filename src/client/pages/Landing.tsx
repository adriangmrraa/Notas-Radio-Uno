import { Link } from 'react-router-dom';
import { ArrowRight, Check, CirclePlay, FileText, Radio, Share2, Sparkles, Waves } from 'lucide-react';
import './Landing.css';

const capabilities = [
  ['Live room', 'Follow a transmission while the newsroom works.'],
  ['From raw to draft', 'Turn the working material into reviewable content.'],
  ['Editorial review', 'Keep a clear handoff before publishing.'],
  ['Publishing flow', 'Prepare each approved piece for its next channel.'],
];

const plans = [
  ['Start', 'For teams getting their live workflow in one place.', ['Live operation workspace', 'Editorial review flow']],
  ['Newsroom', 'For programs that coordinate a recurring production rhythm.', ['Everything in Start', 'Shared content pipeline', 'Publishing preparation']],
  ['Media', 'For organizations that need a tailored operating model.', ['Everything in Newsroom', 'Organization support', 'Custom workflow conversation']],
];

export function Landing() {
  return (
    <main className="landing">
      <nav className="landing-nav" aria-label="Primary navigation">
        <Link className="landing-brand" to="/" aria-label="PeriodistApp home"><span>PA</span>PeriodistApp</Link>
        <div className="landing-nav-links"><a href="#how-it-works">How it works</a><a href="#plans">Plans</a></div>
        <div className="landing-nav-actions"><Link to="/login" className="landing-login">Log in</Link><Link to="/register" className="landing-button landing-button-small">Get started</Link></div>
      </nav>

      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-eyebrow"><Radio size={15} /> Built for live newsrooms</p>
          <h1>Make every live moment <em>ready to publish.</em></h1>
          <p className="landing-lede">PeriodistApp gives channels, radio stations, and live programs one operating space to move from the raw signal to reviewed, reusable content.</p>
          <div className="landing-cta-row"><Link to="/register" className="landing-button">Create your workspace <ArrowRight size={17} /></Link><a href="#demo" className="landing-secondary"><CirclePlay size={18} /> See the workflow</a></div>
          <p className="landing-note">A product workspace for teams. No invented promises, just a clearer process.</p>
        </div>
        <ProductDemo />
      </section>

      <section className="landing-problem" aria-labelledby="outcome-title"><p className="landing-section-kicker">THE SHIFT</p><h2 id="outcome-title">The program ends. The work does not have to.</h2><p>When production is spread across chats, tabs, and handoffs, useful material disappears after air. Give the team a visible process for what happens next.</p></section>

      <section id="how-it-works" className="landing-section"><div className="landing-section-heading"><p className="landing-section-kicker">HOW IT WORKS</p><h2>One editorial rhythm, from signal to next step.</h2></div><div className="landing-steps">
        {[['01', 'Follow the live signal', 'Keep the active transmission and its working context in view.'], ['02', 'Shape the raw material', 'Move useful moments into a shared editorial workflow.'], ['03', 'Review and prepare', 'Give each piece an owner and a clear publishing state.']].map(([number, title, description]) => <article key={number} className="landing-step"><span>{number}</span><h3>{title}</h3><p>{description}</p></article>)}
      </div></section>

      <section className="landing-section landing-capabilities"><div className="landing-section-heading"><p className="landing-section-kicker">CAPABILITIES</p><h2>Designed around the work your team already does.</h2></div><div className="landing-capability-grid">{capabilities.map(([title, text], index) => <article key={title} className="landing-capability"><span className="landing-icon">{index === 0 ? <Waves /> : index === 1 ? <FileText /> : index === 2 ? <Check /> : <Share2 />}</span><h3>{title}</h3><p>{text}</p></article>)}</div></section>

      <section id="plans" className="landing-section"><div className="landing-section-heading"><p className="landing-section-kicker">PLANS</p><h2>Choose the level that fits your newsroom.</h2><p>Talk with us to shape the right plan for your operation.</p></div><div className="landing-plan-grid">{plans.map(([name, description, features], index) => <article key={name} className={`landing-plan ${index === 1 ? 'landing-plan-featured' : ''}`}><p className="landing-plan-label">{name}</p><p>{description}</p><ul>{features.map(feature => <li key={feature}><Check size={16} />{feature}</li>)}</ul><Link to="/register" className={index === 1 ? 'landing-button' : 'landing-plan-link'}>{index === 2 ? 'Contact us' : 'Start a workspace'} <ArrowRight size={16} /></Link></article>)}</div></section>

      <section className="landing-final"><Sparkles size={22} /><h2>Give your live team a calmer next step.</h2><p>Bring the people, material, and editorial decisions into one workspace.</p><Link to="/register" className="landing-button">Create your workspace <ArrowRight size={17} /></Link></section>
      <footer className="landing-footer"><span>PeriodistApp</span><span>Editorial workflows for live teams.</span><Link to="/login">Log in</Link></footer>
    </main>
  );
}

function ProductDemo() {
  return <div id="demo" className="landing-demo" aria-label="Illustrative product workflow demo"><div className="demo-top"><span className="demo-live"><i /> LIVE</span><span>Morning Desk</span><span className="demo-time">10:42</span></div><div className="demo-body"><aside><span className="demo-logo">PA</span><span className="demo-active" /><span /><span /><span /></aside><div className="demo-workspace"><div className="demo-heading"><div><p>Live room</p><strong>Morning Desk</strong></div><button type="button">On air</button></div><div className="demo-wave"><div className="demo-wave-label"><Waves size={15} /> Signal activity <span>Illustrative</span></div><div className="demo-bars">{[20, 42, 30, 65, 43, 82, 50, 34, 76, 45, 60, 28, 48, 72, 38, 57, 30, 68].map((height, index) => <i style={{ height }} key={index} />)}</div></div><div className="demo-columns"><DemoColumn title="In review" cards={['Local transport update', 'Interview highlight']} /><DemoColumn title="Ready next" cards={['Short clip outline', 'Quote card draft']} /></div></div></div></div>;
}

function DemoColumn({ title, cards }: { title: string; cards: string[] }) { return <div className="demo-column"><p>{title}<span>{cards.length}</span></p>{cards.map((card, index) => <article key={card}><small>{index === 0 ? 'LIVE MOMENT' : 'EDITORIAL'}</small><strong>{card}</strong><div><i /><span>{index === 0 ? 'Assigned' : 'Draft'}</span></div></article>)}</div>; }

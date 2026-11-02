// Cleaner panel beside a conversation (see CleanerProfile.tsx for both layouts).
import type { Contact } from './api';
import { CleanerPanel } from './CleanerProfile';

export function Cleaner360({ contact, onInsert }: { contact: Contact; conversationId?: number; onInsert?: (text: string) => void }) {
  const tid = contact.l27_team_id;
  if (!tid) {
    return (
      <div className="p360">
        <section className="p360-block">
          <h3>{contact.name}</h3>
          <p className="small muted">Marked as a cleaner but not linked to a Launch27 cleaner. Open them from the Teams page to link.</p>
        </section>
      </div>
    );
  }
  return <CleanerPanel tid={tid} contact={contact} onInsert={onInsert} />;
}

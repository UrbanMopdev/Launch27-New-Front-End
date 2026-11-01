import { useMeta } from '../inbox/util';
import { Icon } from './Icon';

// Call a customer or cleaner. With RingCentral set up, the call rings through the in-app
// softphone (and gets logged); otherwise it opens the device's own dialer (tel: link).
export function CallButton({ phone, label = 'Call', className = 'secondary' }: { phone?: string | null; label?: string; className?: string }) {
  const meta = useMeta();
  if (!phone) return null;
  if (meta.data?.ringcentral) {
    return (
      <button type="button" className={className} onClick={() => window.dispatchEvent(new CustomEvent('workspace:dial', { detail: phone }))}>
        <Icon name="voice" /> {label}
      </button>
    );
  }
  const digits = phone.replace(/[^\d+]/g, '');
  return (
    <a className={className === 'secondary' ? 'button secondary-link' : 'button'} href={`tel:${digits.startsWith('+') || digits.length !== 10 ? digits : `+1${digits}`}`}>
      <Icon name="voice" /> {label}
    </a>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import './notifications.css';

export type Notification = {
  id: string;
  projectId: string;
  message: string;
  read: boolean;
};

export function NotificationBell({ notifications, markRead }: {
  notifications: Notification[];
  markRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const unread = notifications.filter(item => !item.read).length;

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  return <div className="notification-bell" ref={container}
    onBlur={event => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}
    onKeyDown={event => {
      if (!open || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }}>
    <button className="notification-trigger" ref={trigger} type="button" title="Notifications"
      aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <Bell size={18} aria-hidden="true" />
      {unread > 0 && <span className="notification-dot" aria-hidden="true" />}
    </button>
    {open && <section className="notification-panel" id={panelId} aria-labelledby={panelId + '-title'}>
      <div className="notification-heading">
        <h2 id={panelId + '-title'}>Notifications</h2>
        {unread > 0 && <button className="notification-read" type="button" onClick={() => {
          markRead();
          trigger.current?.focus();
        }}>Mark all as read</button>}
      </div>
      {notifications.length ? <ul className="notification-list">{notifications.map(item =>
        <li className={item.read ? '' : 'notification-unread'} key={item.id}>
          <span className="notification-item-dot" aria-hidden="true" />
          {item.message}
        </li>)}</ul> : <p className="notification-empty">You’re all caught up.</p>}
    </section>}
  </div>;
}

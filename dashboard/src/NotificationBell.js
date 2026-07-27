import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { getNotifications, markNotificationRead, markAllNotificationsRead } from './api';

/**
 * The first real UI consumer of GET/PATCH /api/notifications — the client
 * function already existed (api.js) but had zero callers anywhere in the
 * dashboard before this, so notifications were created server-side (see
 * lib/notifications.js) with no way for a user to ever see one. Preference
 * toggles (SettingsPage.js) only matter once there's something to toggle
 * the visibility of.
 */
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [error, setError] = useState(null);
  const containerRef = useRef(null);
  // Derived, not separate state — always set from the same load() response
  // as `notifications` itself, so keeping it as its own useState could only
  // ever drift out of sync with the list it's supposed to summarize.
  const unread = notifications.filter((n) => !n.read).length;

  function load() {
    getNotifications()
      .then((d) => setNotifications(d.notifications || []))
      .catch((e) => setError(e.message));
  }

  useEffect(() => { load(); }, []);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function onToggleOpen() {
    setOpen((v) => {
      if (!v) load(); // refresh right as the panel opens
      return !v;
    });
  }

  async function onMarkRead(id) {
    try {
      await markNotificationRead(id);
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    } catch (e) { setError(e.message); }
  }

  async function onMarkAllRead() {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    } catch (e) { setError(e.message); }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button" onClick={onToggleOpen}
        className="relative rounded-md p-2 text-foreground hover:bg-accent"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="region" aria-label="Notifications" className="absolute right-0 z-50 mt-2 w-80 rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border p-2">
            <span className="text-sm font-medium text-foreground">Notifications</span>
            {unread > 0 && (
              <button type="button" className="text-xs text-muted-foreground hover:underline" onClick={onMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {error && <p className="p-2 text-sm text-destructive">{error}</p>}
            {!error && notifications.length === 0 && <p className="p-3 text-sm text-muted-foreground">No notifications yet.</p>}
            {notifications.map((n) => (
              <button
                key={n.id} type="button" onClick={() => onMarkRead(n.id)}
                className={`block w-full border-b border-border/50 p-2 text-left text-sm hover:bg-accent ${n.read ? 'text-muted-foreground' : 'font-medium text-foreground'}`}
              >
                <div>{n.title}</div>
                {n.message && <div className="text-xs font-normal text-muted-foreground">{n.message}</div>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

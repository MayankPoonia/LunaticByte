// Auth context and the live event connection (Socket.IO). REST is the source of truth: events only
// tell pages to refresh, and every (re)connect triggers a refresh so missed events are recovered.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, getSession, setSession } from './api';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [session, setState] = useState(getSession());
  const [live, setLive] = useState('offline');
  const listeners = useRef(new Set());
  const seen = useRef(new Set());

  const login = useCallback(async (username, password) => {
    const { data } = await api('/auth/login', { method: 'POST', body: { username, password } });
    setSession(data);
    setState(data);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    setState(null);
  }, []);

  useEffect(() => {
    if (!session) return undefined;
    // websocket transport only: no sticky sessions needed behind the load balancer
    const socket = io({ path: '/socket.io', transports: ['websocket'], auth: { token: session.token } });
    const emit = (event) => listeners.current.forEach((fn) => fn(event));
    socket.on('connect', () => {
      setLive('live');
      emit({ type: 'resync' });
    });
    socket.on('disconnect', () => setLive('reconnecting'));
    socket.on('connect_error', () => setLive('reconnecting'));
    socket.on('event', (event) => {
      if (seen.current.has(event.event_id)) return; // duplicate delivery
      seen.current.add(event.event_id);
      if (seen.current.size > 2000) seen.current = new Set([...seen.current].slice(-1000));
      emit(event);
    });
    return () => socket.close();
  }, [session]);

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  return <SessionContext.Provider value={{ session, user: session && session.user, login, logout, live, subscribe }}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);

// Calls `refresh` when one of the given event types arrives (debounced), and on every reconnect.
export function useLiveRefresh(types, refresh) {
  const { subscribe } = useSession();
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    let timer = null;
    return subscribe((event) => {
      if (event.type !== 'resync' && !types.includes(event.type)) return;
      clearTimeout(timer);
      timer = setTimeout(() => ref.current(event), 150);
    });
  }, [subscribe, types.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
}

// Fetch helper with loading / error state.
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    if (!path) return;
    try {
      const { data } = await api(path);
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
    }
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
  }, [load, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: load };
}

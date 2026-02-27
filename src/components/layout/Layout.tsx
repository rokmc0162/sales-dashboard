import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: '#0f172a' }}>
        <Outlet />
      </main>
    </div>
  );
}

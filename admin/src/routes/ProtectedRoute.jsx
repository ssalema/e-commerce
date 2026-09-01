import { Navigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { AppShellSkeleton } from '../components/common/BootSkeleton';

export default function ProtectedRoute({ children }) {
  const { isAuthenticated, user, initialising } = useSelector((s) => s.auth);
  const location = useLocation();

  // The session probe on a hard refresh: the console's own outline, so the shell
  // it resolves into fills in rather than dropping onto a blank page all at once.
  if (initialising) return <AppShellSkeleton pathname={location.pathname} />;

  // Belt and braces: the API also enforces the admin role on every route.
  if (!isAuthenticated || user?.role !== 'admin') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return children;
}

import { Navigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';
import RouteSkeleton from '../components/common/RouteSkeleton';

/**
 * Gate for account-only routes. Waits for the session probe to finish so a hard
 * refresh on /account doesn't bounce a logged-in user to the login page.
 */
export default function ProtectedRoute({ children }) {
  const { isAuthenticated, initialising } = useSelector((s) => s.auth);
  const location = useLocation();

  // The same placeholder the route chunk was already showing, so the probe is one
  // continuous shimmer rather than a skeleton giving way to a spinner.
  if (initialising) return <RouteSkeleton pathname={location.pathname} />;

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }

  return children;
}

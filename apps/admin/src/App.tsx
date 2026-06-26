import { lazy } from 'react';
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { AppShell } from './components/layout/AppShell.js';
import { ClientProvider, useClient } from './lib/client-context.js';

// Route components are code-split so the initial bundle stays small — heavy
// dependencies (charts on the dashboard, the rich-text/AI editor, media grid)
// load only when their route is first visited. AppShell renders the Suspense
// boundary around the routed <Outlet/>.
const Dashboard = lazy(() =>
  import('./components/Dashboard.js').then((m) => ({ default: m.Dashboard })),
);
const MediaLibrary = lazy(() =>
  import('./components/MediaLibrary.js').then((m) => ({ default: m.MediaLibrary })),
);
const Settings = lazy(() =>
  import('./components/Settings.js').then((m) => ({ default: m.Settings })),
);
const ContentLayout = lazy(() =>
  import('./routes/ContentLayout.js').then((m) => ({ default: m.ContentLayout })),
);
const ContentTypesOverview = lazy(() =>
  import('./routes/ContentTypesOverview.js').then((m) => ({ default: m.ContentTypesOverview })),
);
const EntriesList = lazy(() =>
  import('./routes/EntriesList.js').then((m) => ({ default: m.EntriesList })),
);
const EntryEditor = lazy(() =>
  import('./routes/EntryEditor.js').then((m) => ({ default: m.EntryEditor })),
);
const Releases = lazy(() => import('./routes/Releases.js').then((m) => ({ default: m.Releases })));
const Taxonomy = lazy(() => import('./routes/Taxonomy.js').then((m) => ({ default: m.Taxonomy })));
const Workflows = lazy(() =>
  import('./routes/Workflows.js').then((m) => ({ default: m.Workflows })),
);

// Thin route wrappers bind the shared client/connection to the leaf components.
function DashboardRoute() {
  const { client } = useClient();
  return <Dashboard client={client} />;
}

function MediaRoute() {
  const { client, conn } = useClient();
  return <MediaLibrary client={client} locale={conn.locale} />;
}

function SettingsRoute() {
  const { client } = useClient();
  const { section = 'api-keys' } = useParams();
  const navigate = useNavigate();
  return (
    <Settings client={client} section={section} onSection={(s) => navigate(`/settings/${s}`)} />
  );
}

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardRoute /> },
      {
        path: 'content',
        element: <ContentLayout />,
        children: [
          { index: true, element: <ContentTypesOverview /> },
          { path: ':typeId', element: <EntriesList /> },
          { path: ':typeId/new', element: <EntryEditor /> },
          { path: ':typeId/:entryId', element: <EntryEditor /> },
        ],
      },
      { path: 'releases', element: <Releases /> },
      { path: 'workflows', element: <Workflows /> },
      { path: 'taxonomy', element: <Taxonomy /> },
      { path: 'media', element: <MediaRoute /> },
      { path: 'settings', element: <SettingsRoute /> },
      { path: 'settings/:section', element: <SettingsRoute /> },
    ],
  },
]);

export function App() {
  return (
    <ClientProvider>
      <RouterProvider router={router} />
    </ClientProvider>
  );
}

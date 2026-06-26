import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { Dashboard } from './components/Dashboard.js';
import { MediaLibrary } from './components/MediaLibrary.js';
import { Settings } from './components/Settings.js';
import { AppShell } from './components/layout/AppShell.js';
import { ClientProvider, useClient } from './lib/client-context.js';
import { ContentLayout } from './routes/ContentLayout.js';
import { ContentTypesOverview } from './routes/ContentTypesOverview.js';
import { EntriesList } from './routes/EntriesList.js';
import { EntryEditor } from './routes/EntryEditor.js';
import { Releases } from './routes/Releases.js';
import { Taxonomy } from './routes/Taxonomy.js';
import { Workflows } from './routes/Workflows.js';

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

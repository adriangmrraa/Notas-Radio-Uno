import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { PipelineProvider } from './hooks/usePipelineState';
import { AuthProvider } from './contexts/AuthContext';
import { PrivateRoute } from './components/PrivateRoute';
import { OnboardingGuard } from './components/OnboardingGuard';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { ForgotPassword } from './pages/ForgotPassword';
import { AcceptInvite } from './pages/AcceptInvite';
import { Dashboard } from './pages/Dashboard';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { BillingPage } from './pages/BillingPage';
import { SettingsPage } from './pages/SettingsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ScheduledJobsPage } from './pages/ScheduledJobsPage';
import { AgendaPage } from './pages/AgendaPage';
import { ProgramsPage } from './pages/ProgramsPage';
import { PersonsPage } from './pages/PersonsPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { EditorialPage } from './pages/EditorialPage';
import { ReviewPage } from './pages/ReviewPage';
import { ClipsPage } from './pages/ClipsPage';
import { LiveRoomPage } from './pages/LiveRoomPage';
import PipelineEditor from './editor/PipelineEditor';
import { AdminLayout } from './pages/admin/AdminLayout';
import { AdminTenants } from './pages/admin/AdminTenants';
import { AdminTenantDetail } from './pages/admin/AdminTenantDetail';
import { AdminPlans } from './pages/admin/AdminPlans';
import './index.css';
import './App.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <PipelineProvider>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />

            {/* Protected routes with layout */}
            <Route
              element={
                <PrivateRoute>
                  <OnboardingGuard>
                    <Layout />
                  </OnboardingGuard>
                </PrivateRoute>
              }
            >
              <Route path="/onboarding" element={<OnboardingPage />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/review" element={<ReviewPage />} />
              <Route path="/clips" element={<ClipsPage />} />
              <Route path="/en-vivo" element={<LiveRoomPage />} />
              <Route path="/en-vivo/:transmissionId" element={<LiveRoomPage />} />
              <Route path="/editor" element={<PipelineEditor />} />
              <Route path="/programs" element={<ProgramsPage />} />
              <Route path="/persons" element={<PersonsPage />} />
              <Route path="/editorial" element={<EditorialPage />} />
              <Route path="/connections/*" element={<ConnectionsPage />} />
              <Route path="/scheduled" element={<ScheduledJobsPage />} />
              <Route path="/agenda" element={<AgendaPage />} />
              <Route path="/analytics" element={<AnalyticsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/billing" element={<BillingPage />} />
            </Route>

            {/* Super admin de plataforma */}
            <Route
              path="/admin"
              element={
                <PrivateRoute>
                  <AdminLayout />
                </PrivateRoute>
              }
            >
              <Route index element={<Navigate to="/admin/tenants" replace />} />
              <Route path="tenants" element={<AdminTenants />} />
              <Route path="tenants/:id" element={<AdminTenantDetail />} />
              <Route path="plans" element={<AdminPlans />} />
            </Route>

            {/* Redirect root to dashboard */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </PipelineProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);

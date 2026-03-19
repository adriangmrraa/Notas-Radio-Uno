import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { PipelineProvider } from './hooks/usePipelineState';
import App from './App';
import PipelineEditor from './editor/PipelineEditor';
import './App.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PipelineProvider>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/editor" element={<PipelineEditor />} />
        </Routes>
      </PipelineProvider>
    </BrowserRouter>
  </React.StrictMode>
);

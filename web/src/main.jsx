import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HowPage from './How.jsx';
import StrategyPage from './Strategy.jsx';
import './styles.css';

const path = window.location.pathname;
const Page = path.startsWith('/how') ? HowPage : path.startsWith('/strategy') ? StrategyPage : App;

createRoot(document.getElementById('root')).render(<Page />);

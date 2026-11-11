// Adds DOM matchers such as toBeInTheDocument() and toBeDisabled(), and unmounts
// every rendered component after each test.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

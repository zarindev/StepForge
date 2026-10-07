// CareClinic health check — exported from StepForge (profile: load, 10 VUs).
// Run: k6 run script.js
// Environment variables used:
//   BASE_URL (default http://127.0.0.1:8101)
import http from 'k6/http';
import { check } from 'k6';

const BASE_URL = __ENV.BASE_URL || "http://127.0.0.1:8101";

export const options = {
  "scenarios": {
    "main": {
      "executor": "ramping-vus",
      "startVUs": 0,
      "stages": [
        {
          "duration": "1s",
          "target": 2
        },
        {
          "duration": "1s",
          "target": 3
        },
        {
          "duration": "1s",
          "target": 5
        },
        {
          "duration": "1s",
          "target": 7
        },
        {
          "duration": "1s",
          "target": 8
        },
        {
          "duration": "1s",
          "target": 10
        },
        {
          "duration": "29s",
          "target": 10
        }
      ],
      "gracefulRampDown": "5s"
    }
  },
  "thresholds": {
    "http_req_duration": [
      "p(95)<500"
    ],
    "http_req_failed": [
      "rate<0.01"
    ]
  },
  "summaryTrendStats": [
    "avg",
    "min",
    "med",
    "max",
    "p(90)",
    "p(95)",
    "p(99)"
  ]
};

export default function () {
  let res;
  res = http.request("GET", `${BASE_URL}/api/health`, null);
  check(res, { "GET status < 400": (r) => r.status < 400 });
}

# HouseMeds mobile prototype

This is a standalone, mobile-first interactive prototype for the household medication and deal-comparison flow.

## Run with the mock API

From `backend/`, start the mock household service:

```bash
npm run frontend:mock
```

Then open <http://127.0.0.1:63815>. The frontend calls the mock API over the same origin, so opening `index.html` directly is not supported.

## Mock API contract

The mock service is deliberately shaped as the production frontend contract:

- `GET /v1/me/household` — account, house, members, and prescriptions
- `POST /v1/houses/:houseId/members` — create a house member
- `DELETE /v1/members/:memberId` — remove a house member
- `GET /v1/members/:memberId/prescriptions` — list a member's prescriptions
- `POST /v1/members/:memberId/prescriptions` — add a prescription
- `GET /v1/deals?house_id=:houseId` — deal recommendations for the house

Mock data resets whenever the server restarts.

The prototype includes:

- Household member setup and switching between members while adding medicines
- Manual medicine entry and an AI-assistant interaction mock
- A savings summary, deal comparison, and individual deal detail view

The data is local, illustrative prototype data only; no medicine details or prices are fetched or submitted.

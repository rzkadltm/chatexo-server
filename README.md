# ChatExo WebRTC Signaling Server

A simple signaling server for WebRTC applications using **Socket.io** and **Express**. This server allows multiple users to join rooms, exchange WebRTC offers/answers, and share ICE candidates for peer-to-peer connections.

---

## Table of Contents

- [Features](#features)

---

## Features

- REST API for health check and room information.
- Real-time communication using Socket.io.
- Room management with user join/leave notifications.
- WebRTC signaling support (offer, answer, ICE candidates).
- Automatic cleanup of empty rooms older than 1 hour.
- Simple password-protected rooms.
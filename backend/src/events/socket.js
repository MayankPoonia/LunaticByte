// Socket.IO server: authenticated with the same JWT as the REST API.
// Staff (analyst, manager) join the "staff" room; a cardholder joins only "customer:<own id>",
// so a cardholder can never receive another customer's events or any alert/score data.
const { Server } = require('socket.io');
const { verifyToken, STAFF } = require('../middleware/auth');

function createSocketServer(httpServer) {
  const io = new Server(httpServer, { path: '/socket.io', cors: { origin: true } });
  io.use((socket, next) => {
    try {
      socket.user = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const u = socket.user;
    if (STAFF.includes(u.role)) socket.join('staff');
    else if (u.role === 'CARDHOLDER' && u.customer_id) socket.join(`customer:${u.customer_id}`);
    socket.emit('ready', { role: u.role });
  });

  function deliver(event) {
    const room = event.audience === 'staff' ? 'staff' : event.audience;
    io.to(room).emit('event', { event_id: event.event_id, type: event.type, created_at: event.created_at, payload: event.payload });
  }
  return { io, deliver };
}

module.exports = { createSocketServer };

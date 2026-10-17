const { db, admin } = require('./firebase');

const registrationRef = (guildId, userId) => db.collection('guilds').doc(guildId).collection('registrations').doc(userId);
const historyRef = (guildId, userId) => registrationRef(guildId, userId).collection('membershipEvents');
const timestampMs = value => typeof value?.toMillis === 'function' ? value.toMillis() : null;

// Ao sair, invalida a autorização atual sem apagar o documento ou seus dados históricos.
async function onMemberLeave(member) {
  const ref = registrationRef(member.guild.id, member.id);
  const event = historyRef(member.guild.id, member.id).doc();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    tx.update(ref, {
      status: 'left',
      leftAt: admin.firestore.FieldValue.serverTimestamp(),
      previousStatus: snap.data().status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(event, { type: 'left', previousStatus: snap.data().status, at: admin.firestore.FieldValue.serverTimestamp() });
  });
}

// Compara a entrada atual com a última aprovação. Isso também identifica uma
// saída e reentrada ocorridas enquanto o bot estava desligado.
async function reconcileMembership(member) {
  const ref = registrationRef(member.guild.id, member.id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  const joinedAt = member.joinedTimestamp;
  const approvedAt = timestampMs(data.reviewedAt);
  const createdAt = timestampMs(data.createdAt);
  const reference = data.status === 'approved' ? approvedAt : data.status === 'pending' ? createdAt : null;
  if (reference && joinedAt && joinedAt > reference + 1000) {
    const event = historyRef(member.guild.id, member.id).doc();
    await db.runTransaction(async tx => {
      const current = await tx.get(ref);
      if (!current.exists) return;
      const c = current.data();
      const currentRef = c.status === 'approved' ? timestampMs(c.reviewedAt) : c.status === 'pending' ? timestampMs(c.createdAt) : null;
      if (!currentRef || joinedAt <= currentRef + 1000) return;
      tx.update(ref, {status: 'left', previousStatus: c.status, membershipReconciledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      tx.set(event, {type:'rejoin_detected', previousStatus:c.status, joinedAt:admin.firestore.Timestamp.fromMillis(joinedAt), at:admin.firestore.FieldValue.serverTimestamp()});
    });
    return (await ref.get()).data();
  }
  return data;
}

module.exports = { onMemberLeave, reconcileMembership };

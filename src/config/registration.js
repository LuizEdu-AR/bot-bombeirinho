const { roles } = require('./ids');
const command = [roles.chefe, roles.chefeAdjunto, roles.chefeBatalhao];
const officers = [roles.tenente, roles.capitao, ...command];
const registrationTypes = {
 cadete: { label: 'Cadete', roleId: roles.cadete, approvers: officers, extraRoles: [roles.bombeiros] },
 staff: { label: 'Staff', roleId: roles.staff, approvers: [...command, roles.staff] },
 juridico: { label: 'Jurídico', roleId: roles.juridico, approvers: [roles.capitao, ...command] },
 hospitalNorte: { label: 'Hospital Norte', roleId: roles.hospitalNorte, approvers: command },
 hospitalSul: { label: 'Hospital Sul', roleId: roles.hospitalSul, approvers: command },
 policiaNorte: { label: 'Polícia Norte', roleId: roles.policiaNorte, approvers: command },
 policiaSul: { label: 'Polícia Sul', roleId: roles.policiaSul, approvers: command },
 professor: { label: 'Professor', roleId: roles.professor, approvers: command },
 convidado: { label: 'Convidado', roleId: roles.convidado, approvers: officers }
};
module.exports = { registrationTypes };

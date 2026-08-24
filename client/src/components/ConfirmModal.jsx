import React from 'react';

const ConfirmModal = ({ isOpen, onClose, onConfirm, title, message }) => {
  if (!isOpen) return null;

  return (
    <div style={modalOverlayStyle}>
      <div style={modalContentStyle}>
        <h3>{title}</h3>
        <p>{message}</p>
        <div style={buttonGroupStyle}>
          <button onClick={onClose}>Cancel ❌</button>
          <button onClick={onConfirm} style={{ backgroundColor: 'red', color: 'white' }}>
            Delete 🗑️
          </button>
        </div>
      </div>
    </div>
  );
};

const modalOverlayStyle = {
  position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
  alignItems: 'center', justifyContent: 'center'
};

const modalContentStyle = {
  background: '#fff', padding: '20px', borderRadius: '8px', width: '300px'
};

const buttonGroupStyle = {
  display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px'
};

// 🚩 Allows other files to import this component
export default ConfirmModal;
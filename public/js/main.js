// WhatsApp Webhook Manager Frontend JS

document.addEventListener('DOMContentLoaded', function() {
  // Initialize tooltips if Bootstrap is available
  if (typeof bootstrap !== 'undefined' && bootstrap.Tooltip) {
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
      return new bootstrap.Tooltip(tooltipTriggerEl);
    });
  }

  // Handle QR code refresh
  const refreshQRButtons = document.querySelectorAll('.refresh-qr');
  if (refreshQRButtons) {
    refreshQRButtons.forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        const instanceId = this.dataset.instance;
        refreshQRCode(instanceId);
      });
    });
  }

  // Handle instance status refresh
  const refreshStatusButtons = document.querySelectorAll('.refresh-status');
  if (refreshStatusButtons) {
    refreshStatusButtons.forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        const instanceId = this.dataset.instance;
        refreshStatus(instanceId);
      });
    });
  }

  // Handle instance deletion
  const deleteButtons = document.querySelectorAll('.delete-instance');
  if (deleteButtons) {
    deleteButtons.forEach(button => {
      button.addEventListener('click', function(e) {
        e.preventDefault();
        const instanceId = this.dataset.instance;
        const instanceName = this.dataset.name;
        
        if (confirm(`Are you sure you want to delete the WhatsApp instance "${instanceName}"?`)) {
          deleteInstance(instanceId);
        }
      });
    });
  }

  // Handle add instance form submission
  const addInstanceForm = document.getElementById('add-instance-form');
  if (addInstanceForm) {
    addInstanceForm.addEventListener('submit', function(e) {
      e.preventDefault();
      
      const instanceName = document.getElementById('instance-name').value;
      const recipientNumber = document.getElementById('recipient-number').value;
      const webhookPath = document.getElementById('webhook-path').value;
      
      addInstance(instanceName, recipientNumber, webhookPath);
    });
  }
});

// Function to refresh QR code
function refreshQRCode(instanceId) {
  const qrContainer = document.querySelector(`.qr-container[data-instance="${instanceId}"]`);
  if (qrContainer) {
    qrContainer.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"><span class="visually-hidden">Loading...</span></div><p>Generating QR code...</p></div>';
    
    fetch(`/api/instance/${instanceId}/qr`, {
      method: 'POST'
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        // Redirect to QR page or update the container
        window.location.href = `/instance/${instanceId}/qr`;
      } else {
        qrContainer.innerHTML = `<div class="alert alert-danger">${data.message}</div>`;
      }
    })
    .catch(error => {
      qrContainer.innerHTML = `<div class="alert alert-danger">Error: ${error.message}</div>`;
    });
  }
}

// Function to refresh instance status
function refreshStatus(instanceId) {
  const statusElement = document.querySelector(`.instance-status[data-instance="${instanceId}"]`);
  if (statusElement) {
    const originalText = statusElement.innerHTML;
    statusElement.innerHTML = 'Checking...';
    
    fetch(`/api/instance/${instanceId}/status`)
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        statusElement.innerHTML = data.status;
        statusElement.className = `instance-status status-${data.status.toLowerCase()}`;
      } else {
        statusElement.innerHTML = originalText;
        alert(`Error: ${data.message}`);
      }
    })
    .catch(error => {
      statusElement.innerHTML = originalText;
      alert(`Error: ${error.message}`);
    });
  }
}

// Function to delete an instance
function deleteInstance(instanceId) {
  fetch(`/api/instance/${instanceId}`, {
    method: 'DELETE'
  })
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      // Remove the instance from the UI or reload the page
      const instanceElement = document.querySelector(`.instance-item[data-instance="${instanceId}"]`);
      if (instanceElement) {
        instanceElement.remove();
      } else {
        window.location.reload();
      }
    } else {
      alert(`Error: ${data.message}`);
    }
  })
  .catch(error => {
    alert(`Error: ${error.message}`);
  });
}

// Function to add a new instance
function addInstance(name, recipientNumber, webhookPath) {
  fetch('/api/instance', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      recipientNumber,
      webhookPath
    })
  })
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      // Redirect to instances page or reload
      window.location.href = '/instances';
    } else {
      const errorElement = document.getElementById('add-instance-error');
      if (errorElement) {
        errorElement.textContent = data.message;
        errorElement.style.display = 'block';
      } else {
        alert(`Error: ${data.message}`);
      }
    }
  })
  .catch(error => {
    alert(`Error: ${error.message}`);
  });
} 
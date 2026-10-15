// Pending durable audit deliveries keep the coordinator awake on every host.
export const learningDeliveryPending = entry => Object.keys(entry?.learning_deliveries || {}).length > 0;
